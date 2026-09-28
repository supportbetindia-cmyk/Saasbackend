import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { buildTransactionMessage, DEFAULT_TEMPLATES, type Templates, type TxnType } from './message';
import { sendWhatsAppTemplate } from './interakt';

@Injectable()
export class WhatsappService {
  private readonly logger = new Logger('WhatsApp');
  constructor(private readonly prisma: PrismaService) {}

  // The Interakt key + template names to send with. The INTERAKT_API_KEY env is the
  // reliable default; a tenant's own enabled 'updates' account (public.whatsapp_settings)
  // overrides it when present.
  private async config(tenantId: string): Promise<{ apiKey?: string; templates: Templates }> {
    const envKey = process.env.INTERAKT_API_KEY;
    try {
      // Use the tenant's transaction account: prefer the 'updates' role, else any
      // enabled account that has a key. (Templates still key off deposit_approved etc.)
      const rows = await this.prisma.$queryRawUnsafe<{ api_key: string | null; templates: Record<string, string> | null }[]>(
        `select api_key, templates from public.whatsapp_settings
          where tenant_id = $1::uuid and enabled = true and api_key is not null and api_key <> ''
          order by (role = 'updates') desc limit 1`,
        tenantId,
      );
      const row = rows[0];
      const templates = { ...DEFAULT_TEMPLATES, ...(row?.templates ?? {}) };
      return { apiKey: row?.api_key || envKey, templates };
    } catch {
      return { apiKey: envKey, templates: DEFAULT_TEMPLATES };
    }
  }

  /**
   * Best-effort: send the WhatsApp status message for a transaction webhook.
   * NEVER throws — a messaging failure must not fail the webhook. Deduped by
   * (tenant, eventKey) so the same transaction+status+template is sent at most once.
   * Only called from the webhook path, so CSV/historical imports never message.
   */
  async notifyTransaction(tenantId: string, type: TxnType, body: Record<string, unknown>): Promise<void> {
    try {
      const { apiKey, templates } = await this.config(tenantId);
      if (!apiKey) return; // not configured yet — silently skip
      const msg = buildTransactionMessage(type, body, templates);
      if (!msg || !msg.templateName) return; // no phone / no template

      const s = (v: unknown) => (v === undefined || v === null ? '' : String(v).trim());
      const userId = s(body.user_id ?? body.User_id);
      const txnId = s(body.Transaction_id ?? body.transaction_id);
      const status = s(body.payment_status ?? body.Payment_status ?? body.status ?? body.Status);

      // Claim + record the send in public.message_log (event_key is unique → this is
      // both the dedup guard AND the row the Automations page shows). If the row
      // already exists, this transaction+status was already messaged.
      const inserted = await this.prisma.$executeRawUnsafe(
        `insert into public.message_log
           (event_key, channel, template, event_type, transaction_id, transaction_status, mobile, user_id, payload, status, tenant_id)
         values ($1,'whatsapp',$2,$3,$4,$5,$6,$7,$8::jsonb,'queued',$9::uuid)
         on conflict (event_key) do nothing`,
        msg.eventKey, msg.templateName, type, txnId || null, status || null,
        msg.phoneNumber, userId || null, JSON.stringify(body), tenantId,
      );
      if (inserted === 0) return; // duplicate — already messaged

      const res = await sendWhatsAppTemplate(msg, apiKey);
      if (res.ok) {
        await this.prisma.$executeRawUnsafe(
          `update public.message_log set status='sent', sent_at=now(), provider_message_id=$2, updated_at=now() where event_key=$1`,
          msg.eventKey, res.id ?? null,
        );
      } else {
        await this.prisma.$executeRawUnsafe(
          `update public.message_log set status='failed', last_error=$2, attempt_count=attempt_count+1, updated_at=now() where event_key=$1`,
          msg.eventKey, res.error ?? 'send failed',
        );
        this.logger.warn(`send failed (${type} → ${msg.templateName}): ${res.error}`);
      }
    } catch (e) {
      this.logger.warn(`notifyTransaction error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
