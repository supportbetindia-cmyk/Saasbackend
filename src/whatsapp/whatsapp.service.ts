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
          where tenant_id = $1 and enabled = true and api_key is not null and api_key <> ''
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

      // Claim the event first; if the row already exists, it was already sent.
      const inserted = await this.prisma.$executeRawUnsafe(
        `insert into saas.whatsapp_log (id, tenant_id, event_key, created_at)
         values (gen_random_uuid()::text, $1, $2, now())
         on conflict (tenant_id, event_key) do nothing`,
        tenantId, msg.eventKey,
      );
      if (inserted === 0) return; // duplicate — already messaged

      const res = await sendWhatsAppTemplate(msg, apiKey);
      if (!res.ok) this.logger.warn(`send failed (${type} → ${msg.templateName}): ${res.error}`);
    } catch (e) {
      this.logger.warn(`notifyTransaction error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
