import { createHash } from 'node:crypto';
import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { normalizePhone } from '../whatsapp/message';
import { sendWhatsAppText } from '../whatsapp/interakt';
import { resolveInteraktKey } from '../whatsapp/interakt-keys';

// WhatsApp only allows a free-text reply within 24h of the customer's last message.
const WINDOW_HOURS = 24;

type ConversationRow = {
  mobile: string;
  customer_id: string | null;
  name: string | null;
  last_customer_reply_at: Date | null;
  window_open: boolean;
  last_text: string | null;
  last_type: string | null;
  last_at: Date | null;
  unread: number;
};

type CustomerRow = {
  id: string; name: string | null; phone: string | null;
  last_customer_reply_at: Date | null; marketing_opt_out: boolean;
};

type MessageRow = {
  id: string; event_type: string | null; template: string | null; detail: string | null;
  status: string | null; created_at: Date; sent_at: Date | null; delivered_at: Date | null; read_at: Date | null;
};

@Injectable()
export class InboxService {
  private readonly log = new Logger('Inbox');
  constructor(private readonly prisma: PrismaService) {}

  /** Conversations = phone numbers that have sent us at least one inbound message,
   * newest activity first, with an unread count and whether the 24h window is open. */
  async list(tenantId: string) {
    const rows = await this.prisma.$queryRawUnsafe<ConversationRow[]>(
      `with inbound_phones as (
         select distinct mobile from public.message_log
          where tenant_id = $1::uuid and event_type = 'inbound' and mobile is not null and mobile <> ''
       )
       select ip.mobile,
              cust.id as customer_id, cust.name, cust.last_customer_reply_at,
              coalesce(cust.last_customer_reply_at > now() - interval '${WINDOW_HOURS} hours', false) as window_open,
              lm.detail as last_text, lm.event_type as last_type, lm.created_at as last_at,
              (select count(*)::int from public.message_log u
                 where u.tenant_id = $1::uuid and u.mobile = ip.mobile
                   and u.event_type = 'inbound' and u.status = 'received') as unread
         from inbound_phones ip
         left join lateral (
           select detail, event_type, created_at from public.message_log m
            where m.tenant_id = $1::uuid and m.mobile = ip.mobile
            order by m.created_at desc limit 1
         ) lm on true
         left join saas.customers cust
           on cust.tenant_id = $1::uuid
          and right(regexp_replace(coalesce(cust.phone, ''), '[^0-9]', '', 'g'), 10) = ip.mobile
        order by lm.created_at desc nulls last
        limit 100`,
      tenantId,
    );
    return rows.map((r) => ({
      mobile: r.mobile,
      customerId: r.customer_id,
      name: r.name,
      lastText: r.last_text,
      lastDirection: r.last_type === 'inbound' ? 'in' : 'out',
      lastAt: r.last_at,
      unread: Number(r.unread ?? 0),
      windowOpen: r.window_open,
    }));
  }

  /** last_customer_reply_at / marketing_opt_out live on saas.customers but aren't in the
   * Prisma schema (added via raw ALTER), so we read the customer with raw SQL. */
  private async customerRow(tenantId: string, customerId: string): Promise<CustomerRow | undefined> {
    const rows = await this.prisma.$queryRawUnsafe<CustomerRow[]>(
      `select id::text, name, phone, last_customer_reply_at, marketing_opt_out
         from saas.customers where tenant_id = $1::uuid and id = $2::uuid limit 1`,
      tenantId, customerId,
    );
    return rows[0];
  }

  /** One conversation: identity + every message (both directions), oldest first. */
  async thread(tenantId: string, customerId: string) {
    const customer = await this.customerRow(tenantId, customerId);
    if (!customer) throw new NotFoundException('Customer not found');
    const phone = normalizePhone(customer.phone ?? '');
    if (!phone) throw new BadRequestException('Customer has no valid phone');

    const messages = await this.prisma.$queryRawUnsafe<MessageRow[]>(
      `select id::text, event_type, template, detail, status, created_at, sent_at, delivered_at, read_at
         from public.message_log
        where tenant_id = $1::uuid and mobile = $2
        order by created_at asc
        limit 500`,
      tenantId, phone.phoneNumber,
    );
    await this.markRead(tenantId, phone.phoneNumber);

    return {
      customer: { id: customer.id, name: customer.name, phone: customer.phone, optOut: customer.marketing_opt_out },
      windowOpen: this.windowOpen(customer.last_customer_reply_at),
      messages: messages.map((m) => ({
        id: m.id,
        direction: m.event_type === 'inbound' ? 'in' : 'out',
        text: m.detail || m.template || '',
        kind: m.event_type,
        status: m.status,
        at: m.created_at,
      })),
    };
  }

  /** Send a free-text reply — only allowed inside the 24h window. Records it as an
   * outbound 'reply' row so it appears in the thread. */
  async reply(tenantId: string, customerId: string, text: string) {
    const body = (text ?? '').trim();
    if (!body) throw new BadRequestException('Message is empty');
    if (body.length > 4096) throw new BadRequestException('Message too long');

    const customer = await this.customerRow(tenantId, customerId);
    if (!customer) throw new NotFoundException('Customer not found');
    if (customer.marketing_opt_out) throw new BadRequestException('Customer has opted out');
    if (!this.windowOpen(customer.last_customer_reply_at)) {
      throw new BadRequestException('The 24-hour reply window has closed. Send an approved template instead.');
    }
    const phone = normalizePhone(customer.phone ?? '');
    if (!phone) throw new BadRequestException('Customer has no valid phone');

    const apiKey = await resolveInteraktKey(this.prisma, tenantId, 'updates');
    if (!apiKey) throw new BadRequestException('WhatsApp is not configured for this company');

    const eventKey = 'reply|' + createHash('sha256').update(`${tenantId}|${phone.phoneNumber}|${body}|${Date.now()}`).digest('hex');
    // Record first (status queued) so a crash mid-send still leaves a trace.
    await this.prisma.$executeRawUnsafe(
      `insert into public.message_log (event_key, channel, event_type, mobile, detail, status, tenant_id, created_at)
       values ($1,'whatsapp','reply',$2,$3,'queued',$4::uuid, now())`,
      eventKey, phone.phoneNumber, body, tenantId,
    );
    const res = await sendWhatsAppText({ phoneNumber: phone.phoneNumber, countryCode: phone.countryCode, message: body }, apiKey);
    if (res.ok) {
      await this.prisma.$executeRawUnsafe(
        `update public.message_log set status='sent', sent_at=now(), provider_message_id=$2, updated_at=now() where event_key=$1`,
        eventKey, res.id ?? null,
      );
      return { ok: true };
    }
    await this.prisma.$executeRawUnsafe(
      `update public.message_log set status='failed', last_error=$2, updated_at=now() where event_key=$1`,
      eventKey, res.error ?? 'send failed',
    );
    this.log.warn(`reply failed to ${phone.phoneNumber}: ${res.error}`);
    throw new BadRequestException(res.error || 'Failed to send message');
  }

  /** Clear the unread flag on a phone's inbound messages. */
  async markRead(tenantId: string, phone10: string): Promise<void> {
    await this.prisma.$executeRawUnsafe(
      `update public.message_log set status='read', updated_at=now()
        where tenant_id = $1::uuid and mobile = $2 and event_type='inbound' and status='received'`,
      tenantId, phone10,
    );
  }

  private windowOpen(lastReplyAt: Date | null): boolean {
    if (!lastReplyAt) return false;
    return Date.now() - lastReplyAt.getTime() < WINDOW_HOURS * 3_600_000;
  }
}
