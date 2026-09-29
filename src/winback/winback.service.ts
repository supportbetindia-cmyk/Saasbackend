import { createHash } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { normalizePhone } from '../whatsapp/message';
import { sendWhatsAppTemplate } from '../whatsapp/interakt';

// Automatic win-back: message players who went inactive (7–90 days since their last
// transaction) at most once every 7 days, from the tenant's retention account.
const INACTIVE_MIN_DAYS = 7; // must be quiet this long to count as inactive
const INACTIVE_MAX_DAYS = 90; // don't chase long-churned players (deliverability)
const COOLDOWN_DAYS = 7; // at most one win-back per player per 7 days
const DEFAULT_CAP = 200; // per company per run (WhatsApp marketing caps + deliverability)

export type WinbackResult = { eligible: number; sent: number; failed: number; skipped: number; reason?: string };

type Candidate = { id: string; name: string | null; phone: string | null; userId: string | null };

@Injectable()
export class WinbackService {
  private readonly logger = new Logger('Winback');
  constructor(private readonly prisma: PrismaService) {}

  /** The retention account's key + win-back template for a tenant. Gated on the
   * account being ENABLED — that checkbox is the on/off switch for this automation. */
  private async config(tenantId: string): Promise<{ apiKey?: string; templateName?: string; lang: string }> {
    const envKey = process.env.INTERAKT_CAMPAIGN_API_KEY || process.env.INTERAKT_API_KEY;
    const lang = process.env.WINBACK_LANG || 'en';
    try {
      const rows = await this.prisma.$queryRawUnsafe<{ api_key: string | null; templates: Record<string, string> | null }[]>(
        `select api_key, templates from public.whatsapp_settings
          where tenant_id = $1::uuid and enabled = true and api_key is not null and api_key <> ''
            and role ~* 'retention|camp'
          order by (role = 'retention') desc limit 1`,
        tenantId,
      );
      const row = rows[0];
      if (!row) return { apiKey: undefined, templateName: undefined, lang }; // no enabled retention account → off
      const templateName = row.templates?.winback || process.env.WINBACK_TEMPLATE || 'inactive_users';
      return { apiKey: row.api_key || envKey, templateName, lang };
    } catch {
      return { apiKey: undefined, templateName: undefined, lang };
    }
  }

  /** Inactive players (7–90 days since last deposit OR withdrawal) with a phone,
   * not already win-back-messaged in the cooldown window. */
  async findInactive(tenantId: string, limit: number): Promise<Candidate[]> {
    return this.prisma.$queryRawUnsafe<Candidate[]>(
      `select c.id, c.name, c.phone, c.external_user_id as "userId"
       from saas.customers c
       where c.tenant_id = $1
         and c.phone is not null and c.phone <> ''
         and greatest(c.last_deposit_at, c.last_withdrawal_at) <  now() - interval '${INACTIVE_MIN_DAYS} days'
         and greatest(c.last_deposit_at, c.last_withdrawal_at) >= now() - interval '${INACTIVE_MAX_DAYS} days'
         and not exists (
           select 1 from public.message_log m
           where m.tenant_id = $1::uuid and m.event_type = 'winback'
             and m.mobile = right(regexp_replace(coalesce(c.phone, ''), '[^0-9]', '', 'g'), 10)
             and m.created_at > now() - interval '${COOLDOWN_DAYS} days'
         )
       order by greatest(c.last_deposit_at, c.last_withdrawal_at) desc
       limit $2`,
      tenantId, limit,
    );
  }

  /** Send the win-back to this tenant's eligible inactive players (best-effort, capped). */
  async runTenant(tenantId: string, cap = DEFAULT_CAP): Promise<WinbackResult> {
    const { apiKey, templateName, lang } = await this.config(tenantId);
    if (!apiKey || !templateName) return { eligible: 0, sent: 0, failed: 0, skipped: 0, reason: 'no enabled retention account' };

    const players = await this.findInactive(tenantId, cap);
    let sent = 0, failed = 0, skipped = 0;
    for (const p of players) {
      const phone = normalizePhone(p.phone ?? '');
      if (!phone) { skipped++; continue; }
      const eventKey = createHash('sha256')
        .update(`winback|${tenantId}|${p.userId || phone.phoneNumber}|${new Date().toISOString().slice(0, 10)}`)
        .digest('hex');

      // Claim + record in message_log; unique event_key stops a double-send within a day.
      const inserted = await this.prisma.$executeRawUnsafe(
        `insert into public.message_log (event_key, channel, template, event_type, mobile, user_id, payload, status, tenant_id)
         values ($1,'whatsapp',$2,'winback',$3,$4,'{}'::jsonb,'queued',$5::uuid)
         on conflict (event_key) do nothing`,
        eventKey, templateName, phone.phoneNumber, p.userId ?? null, tenantId,
      );
      if (inserted === 0) { skipped++; continue; }

      const res = await sendWhatsAppTemplate(
        { phoneNumber: phone.phoneNumber, countryCode: phone.countryCode, templateName, languageCode: lang, bodyValues: [p.name || 'there'] },
        apiKey,
      );
      if (res.ok) {
        sent++;
        await this.prisma.$executeRawUnsafe(
          `update public.message_log set status='sent', sent_at=now(), provider_message_id=$2, updated_at=now() where event_key=$1`,
          eventKey, res.id ?? null,
        );
      } else {
        failed++;
        await this.prisma.$executeRawUnsafe(
          `update public.message_log set status='failed', last_error=$2, attempt_count=attempt_count+1, updated_at=now() where event_key=$1`,
          eventKey, res.error ?? 'send failed',
        );
      }
    }
    if (sent || failed) this.logger.log(`tenant ${tenantId}: sent ${sent}, failed ${failed}, skipped ${skipped} of ${players.length}`);
    return { eligible: players.length, sent, failed, skipped };
  }

  /** How many inactive players are eligible right now (for the UI, no sending). */
  async preview(tenantId: string): Promise<{ eligible: number; configured: boolean }> {
    const { apiKey, templateName } = await this.config(tenantId);
    const rows = await this.findInactive(tenantId, 100000);
    return { eligible: rows.length, configured: Boolean(apiKey && templateName) };
  }
}
