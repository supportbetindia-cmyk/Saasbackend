import { createHash } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

// Keywords a customer might send. Tightened once we see real Interakt payloads.
const OPT_OUT_RE = /\b(stop|unsubscribe|opt\s*out|remove me|do not message)\b/i;
const HELP_RE = /\b(help|support|assist|problem|issue|need help)\b/i;

// Pull the first string value whose KEY matches, searching the whole payload tree.
// Interakt nests things (data.customer.phone_number, data.message.message …) and the
// exact shape varies, so we search by key name instead of hard-coding a path.
function findByKey(obj: unknown, re: RegExp): string | undefined {
  if (obj == null) return undefined;
  if (Array.isArray(obj)) {
    for (const v of obj) { const r = findByKey(v, re); if (r) return r; }
    return undefined;
  }
  if (typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) {
      if (re.test(k) && (typeof v === 'string' || typeof v === 'number') && String(v).trim() !== '') return String(v);
    }
    for (const v of Object.values(obj)) { const r = findByKey(v, re); if (r) return r; }
  }
  return undefined;
}

function digits10(v: string | undefined): string | undefined {
  if (!v) return undefined;
  const d = v.replace(/\D/g, '');
  return d.length >= 10 ? d.slice(-10) : undefined;
}

@Injectable()
export class LifecycleInboundService {
  private readonly log = new Logger('Interakt');
  constructor(private readonly prisma: PrismaService) {}

  /** Process one Interakt webhook event. Best-effort — never throws. */
  async handle(tenantId: string, body: Record<string, unknown>): Promise<{ ok: true; action: string }> {
    this.logRaw(body); // always keep the raw payload so we can refine the parser

    const type = String(findByKey(body, /^(type|event|event_type)$/i) ?? '').toLowerCase();
    const messageId = findByKey(body, /^(message_id|id)$/i);

    // 1) Delivery/status update for a template WE sent (matched by our stored id).
    if (/sent|deliver|read|fail/.test(type) && messageId) {
      const status = /read/.test(type) ? 'read' : /deliver/.test(type) ? 'delivered' : /fail/.test(type) ? 'failed' : 'sent';
      await this.prisma.$executeRawUnsafe(
        `update public.message_log
           set status = case when $2 = 'failed' then 'failed' else 'sent' end,
               delivered_at = case when $2 in ('delivered','read') then coalesce(delivered_at, now()) else delivered_at end,
               read_at = case when $2 = 'read' then now() else read_at end,
               updated_at = now()
         where provider_message_id = $1`,
        String(messageId), status,
      );
      return { ok: true, action: `status:${status}` };
    }

    // 2) Inbound message / button reply from the customer.
    const phone = digits10(findByKey(body, /phone|mobile|^from$|contact/i));
    if (!phone) return { ok: true, action: 'ignored:no-phone' };
    const text = String(findByKey(body, /^(message|text|body|button.*|reply|payload)/i) ?? '');
    const optOut = OPT_OUT_RE.test(text);
    const help = HELP_RE.test(text);

    // last_customer_reply_at always; flags flip ON but never back OFF here (only STOP sets opt-out).
    await this.prisma.$executeRawUnsafe(
      `update saas.customers
         set last_customer_reply_at = now(),
             marketing_opt_out = marketing_opt_out or $3,
             support_issue_open = support_issue_open or $4,
             updated_at = now()
       where tenant_id = $1
         and right(regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g'), 10) = $2`,
      tenantId, phone, optOut, help,
    );

    // Store the customer's message as an inbound log row so the inbox can show the
    // thread. event_key dedups Interakt's webhook retries (by provider id, else a hash).
    if (text.trim()) {
      const eventKey = 'inbound|' + (messageId ? String(messageId) : createHash('sha256').update(`${tenantId}|${phone}|${text}|${new Date().toISOString().slice(0, 16)}`).digest('hex'));
      await this.prisma.$executeRawUnsafe(
        `insert into public.message_log (event_key, channel, event_type, mobile, detail, provider_message_id, status, tenant_id, created_at)
         values ($1,'whatsapp','inbound',$2,$3,$4,'received',$5::uuid, now())
         on conflict (event_key) do nothing`,
        eventKey, phone, text, messageId ? String(messageId) : null, tenantId,
      ).catch(() => undefined);
    }
    return { ok: true, action: optOut ? 'opt_out' : help ? 'support_open' : 'reply' };
  }

  private logRaw(body: Record<string, unknown>) {
    this.prisma.$executeRawUnsafe(
      `insert into public.webhook_logs (source, method, content_type, token_ok, status, raw, created_at)
       values ('interakt','POST','application/json',true,200,$1::jsonb, now())`,
      JSON.stringify(body),
    ).catch(() => undefined);
  }
}
