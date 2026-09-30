import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { sendWhatsAppTemplate } from './interakt';
import { resolveInteraktKey, type SendRole } from './interakt-keys';

// Give up after this many total tries (1 original send + retries). Past this the row
// stays 'failed' and is never picked up again — a "dead letter" you can inspect.
const MAX_ATTEMPTS = 5;
const BATCH = 50;          // rows processed per tick (bounds each run's work + API load)
const LOCK_MINUTES = 2;    // how long a claimed row is hidden from other workers

// The replay envelope we stash in message_log.payload.send at send time. Everything
// here + the row's `template` and `mobile` columns is enough to re-send exactly.
type SendEnvelope = {
  countryCode?: string;
  languageCode?: string;
  bodyValues?: string[];
  role?: SendRole;
};

type DueRow = {
  id: string;
  tenant_id: string;
  template: string | null;
  mobile: string | null;
  event_type: string | null;
  payload: unknown;      // jsonb — object or string depending on driver
  attempt_count: number;
};

@Injectable()
export class MessageRetryService {
  private readonly log = new Logger('WhatsAppRetry');
  constructor(private readonly prisma: PrismaService) {}

  /** One pass: claim due failures, try to re-send each, record the outcome. Returns a
   * small summary for logging. Safe to run concurrently — the claim locks its rows. */
  async runOnce(): Promise<{ claimed: number; sent: number; failed: number; skipped: number }> {
    const rows = await this.claimDue();
    let sent = 0, failed = 0, skipped = 0;
    for (const r of rows) {
      const env = this.envelope(r.payload);
      // Legacy rows (failed before we stored a replay envelope) can't be replayed.
      // Don't burn attempts forever on them — push them far out so they drop off.
      if (!env || !r.template || !r.mobile) {
        skipped++;
        await this.markDead(r.id, 'no replay payload');
        continue;
      }
      const apiKey = await resolveInteraktKey(this.prisma, r.tenant_id, env.role ?? 'updates');
      const res = await sendWhatsAppTemplate(
        {
          phoneNumber: r.mobile,
          countryCode: env.countryCode ?? '+91',
          templateName: r.template,
          languageCode: env.languageCode ?? 'en',
          bodyValues: env.bodyValues ?? [],
        },
        apiKey,
      );
      if (res.ok) { sent++; await this.markSent(r.id, res.id ?? null); }
      else { failed++; await this.markRetry(r.id, r.attempt_count, res.error ?? 'send failed'); }
    }
    if (sent || failed) this.log.log(`retry: claimed ${rows.length}, sent ${sent}, failed ${failed}, skipped ${skipped}`);
    return { claimed: rows.length, sent, failed, skipped };
  }

  /** Atomically claim up to BATCH due rows: failed, under the attempt cap, past their
   * next_attempt_at, not currently locked. `for update skip locked` means two workers
   * running at once each grab a DIFFERENT set — never the same row twice. */
  private claimDue(): Promise<DueRow[]> {
    return this.prisma.$queryRawUnsafe<DueRow[]>(
      `update public.message_log m
          set locked_until = now() + interval '${LOCK_MINUTES} minutes', updated_at = now()
        where m.id in (
          select id from public.message_log
           where status = 'failed'
             and jsonb_exists(payload, 'send')   -- only rows we can actually replay
             and attempt_count < ${MAX_ATTEMPTS}
             and coalesce(next_attempt_at, created_at) <= now()
             and (locked_until is null or locked_until < now())
           order by coalesce(next_attempt_at, created_at) asc
           limit ${BATCH}
           for update skip locked
        )
        returning m.id, m.tenant_id, m.template, m.mobile, m.event_type, m.payload, m.attempt_count`,
    );
  }

  private async markSent(id: string, providerMessageId: string | null): Promise<void> {
    await this.prisma.$executeRawUnsafe(
      `update public.message_log
          set status='sent', sent_at=now(), provider_message_id=$2,
              locked_until=null, last_error=null, updated_at=now()
        where id=$1`,
      id, providerMessageId,
    );
  }

  /** Failed again: bump the count, record the error, and push the next try out with
   * exponential backoff (4^attempts minutes: 4, 16, 64…). At MAX_ATTEMPTS the claim
   * query stops selecting it, so it becomes a dead letter automatically. */
  private async markRetry(id: string, attemptCount: number, error: string): Promise<void> {
    await this.prisma.$executeRawUnsafe(
      `update public.message_log
          set attempt_count = attempt_count + 1,
              last_error = $2,
              next_attempt_at = now() + (interval '1 minute' * power(4, least($3, 5))),
              locked_until = null, updated_at = now()
        where id=$1`,
      id, error, attemptCount,
    );
  }

  /** Un-retryable row: keep it failed but move it out of the queue's way for good. */
  private async markDead(id: string, error: string): Promise<void> {
    await this.prisma.$executeRawUnsafe(
      `update public.message_log
          set attempt_count = ${MAX_ATTEMPTS}, last_error=$2, locked_until=null, updated_at=now()
        where id=$1`,
      id, error,
    );
  }

  private envelope(payload: unknown): SendEnvelope | null {
    try {
      const obj = typeof payload === 'string' ? JSON.parse(payload) : payload;
      const send = (obj as { send?: SendEnvelope } | null)?.send;
      return send && typeof send === 'object' ? send : null;
    } catch {
      return null;
    }
  }
}
