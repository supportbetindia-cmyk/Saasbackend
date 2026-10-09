import { BadRequestException, Body, Controller, Headers, HttpException, HttpStatus, Param, Post, Query, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { TransactionsService } from '../transactions/transactions.service';
import { WhatsappService } from '../whatsapp/whatsapp.service';
import { normalizePhone, normalizeType } from '../transactions/status';
import { mapWebhook, pick, registrationTime, webhookFingerprint, type WebhookType } from './webhook.mapper';
import { verifyWebhookSecret } from './webhook-secret';

@Controller('webhooks')
export class WebhooksController {
  // ponytail: process-local limiter; move to the API gateway/Redis when the backend runs on multiple instances.
  private readonly limits = new Map<string, { startedAt: number; count: number }>();
  // Safety ceiling only — the provider bursts retries well above the old 120/min, which
  // silently dropped real transactions. Keep it high; raise via env if a tenant needs more.
  private readonly maxPerMinute = Number(process.env.WEBHOOK_RATE_LIMIT_PER_MIN) || 2000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly transactions: TransactionsService,
    private readonly whatsapp: WhatsappService,
  ) {}

  // One endpoint for deposit, withdrawal, update AND register. The provider sends the secret
  // either as an `X-Webhook-Secret` header OR as a `?token=` query param (Get-ID
  // only supports the URL token) — both are accepted.
  @Post(':webhookKey/:type')
  async receive(
    @Param('webhookKey') webhookKey: string,
    @Param('type') rawType: string,
    @Headers('x-webhook-secret') headerSecret: string | undefined,
    @Query('token') token: string | undefined,
    @Body() body: Record<string, unknown>,
  ) {
    if (!['deposit', 'withdrawal', 'update', 'register'].includes(rawType)) {
      throw new BadRequestException('type must be deposit, withdrawal, update or register');
    }
    const tenant = await this.prisma.tenant.findFirst({ where: { webhookKey, status: 'ACTIVE', webhookEnabled: true } });
    if (!tenant) throw new BadRequestException('Unknown or inactive tenant');
    if (!verifyWebhookSecret(headerSecret || token, tenant.webhookSecretHash)) throw new UnauthorizedException('Invalid webhook secret');

    // Log the raw payload BEFORE the rate-limit check so that even dropped (429) webhooks
    // stay visible for debugging (best-effort; never fails the webhook).
    this.logRaw(rawType, body);
    this.checkRateLimit(tenant.id);
    if (rawType === 'register') return this.register(tenant.id, body);

    // "update" doesn't say deposit vs withdrawal — work it out.
    const type = await this.resolveType(rawType, body, tenant.id);

    let input;
    try {
      input = mapWebhook(type, body);
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : 'Invalid webhook payload');
    }
    const fingerprint = webhookFingerprint(type, input, body);
    const processed = await this.prisma.webhookEvent.findUnique({
      where: { tenantId_provider_externalEventId: { tenantId: tenant.id, provider: 'wati', externalEventId: fingerprint.eventId } },
    });
    if (processed?.processingStatus === 'processed') return { ok: true, duplicate: true };

    try {
      const transaction = await this.transactions.ingest(tenant.id, input);
      await this.prisma.webhookEvent.upsert({
        where: { tenantId_provider_externalEventId: { tenantId: tenant.id, provider: 'wati', externalEventId: fingerprint.eventId } },
        update: { payloadHash: fingerprint.payloadHash, processingStatus: 'processed', processedAt: new Date(), error: null },
        create: {
          tenantId: tenant.id, provider: 'wati', externalEventId: fingerprint.eventId,
          eventType: type, payloadHash: fingerprint.payloadHash,
          processingStatus: 'processed', processedAt: new Date(),
        },
      });
      // Fire the WhatsApp status message (best-effort; never fails the webhook).
      void this.whatsapp.notifyTransaction(tenant.id, type, body);
      return { ok: true, type, transactionId: transaction.id };
    } catch (error) {
      await this.prisma.webhookEvent.upsert({
        where: { tenantId_provider_externalEventId: { tenantId: tenant.id, provider: 'wati', externalEventId: fingerprint.eventId } },
        update: { payloadHash: fingerprint.payloadHash, processingStatus: 'failed', error: error instanceof Error ? error.message : String(error) },
        create: {
          tenantId: tenant.id, provider: 'wati', externalEventId: fingerprint.eventId,
          eventType: type, payloadHash: fingerprint.payloadHash,
          processingStatus: 'failed', error: error instanceof Error ? error.message : String(error),
        },
      });
      throw error;
    }
  }

  /** New sign-up from the platform. Idempotent: updates the player if known, converts a
   * WhatsApp lead with the same phone (no external id yet), else creates the player. */
  private async register(tenantId: string, body: Record<string, unknown>) {
    const externalUserId = pick(body, 'user_id', 'User_id');
    if (!externalUserId) throw new BadRequestException('Missing user_id');
    const phone = pick(body, 'mobile_number', 'Mobile_number', 'phone');
    const phoneNormalized = normalizePhone(phone);
    const data = {
      masterId: pick(body, 'Branch_id', 'branch_id'),
      name: pick(body, 'User_name', 'user_name', 'name'),
      phone, phoneNormalized,
      email: pick(body, 'email', 'Email'),
    };
    const registrationAt = registrationTime(pick(body, 'registered_at', 'created_at', 'Register_date', 'registration_date'));
    const strip = <T extends object>(o: T) => Object.fromEntries(Object.entries(o).filter(([, v]) => v != null));

    const existing = await this.prisma.customer.findUnique({ where: { tenantId_externalUserId: { tenantId, externalUserId } } });
    if (existing) {
      // Retries must not move the sign-up date, so keep the first one.
      await this.prisma.customer.update({ where: { id: existing.id }, data: { ...strip(data), registrationAt: existing.registrationAt ?? registrationAt } });
      return { ok: true, type: 'register', action: 'updated', customerId: existing.id };
    }
    const lead = phoneNormalized && await this.prisma.customer.findFirst({ where: { tenantId, externalUserId: null, phoneNormalized } });
    if (lead) {
      await this.prisma.customer.update({ where: { id: lead.id }, data: { ...strip(data), externalUserId, registrationAt } });
      return { ok: true, type: 'register', action: 'lead_converted', customerId: lead.id };
    }
    const created = await this.prisma.customer.create({ data: { tenantId, externalUserId, ...data, registrationAt } });
    return { ok: true, type: 'register', action: 'created', customerId: created.id };
  }

  /** deposit/withdrawal are explicit; "update" is inferred from the body, then the
   * existing transaction, then bank fields (withdrawals carry account/IFSC). */
  private async resolveType(rawType: string, body: Record<string, unknown>, tenantId: string): Promise<WebhookType> {
    if (rawType === 'deposit' || rawType === 'withdrawal') return rawType;
    const fromBody = normalizeType(String(body.type ?? body.Type ?? body.transaction_type ?? body.txn_type ?? ''));
    if (fromBody) return fromBody === 'DEPOSIT' ? 'deposit' : 'withdrawal';

    const txnId = body.Transaction_id ?? body.transaction_id;
    if (txnId) {
      const existing = await this.prisma.transaction.findFirst({
        where: { tenantId, externalTransactionId: String(txnId) },
        select: { transactionType: true },
      });
      if (existing) return existing.transactionType === 'DEPOSIT' ? 'deposit' : 'withdrawal';
    }
    const hasBankFields = Boolean(body.Account_number ?? body.account_number ?? body.Ifsc_code ?? body.ifsc_code);
    return hasBankFields ? 'withdrawal' : 'deposit';
  }

  /** Store the raw incoming payload in public.webhook_logs so it's viewable later
   * (same table the legacy webhook used). Best-effort — never throws. */
  private logRaw(source: string, body: Record<string, unknown>) {
    this.prisma.$executeRawUnsafe(
      `insert into public.webhook_logs (source, method, content_type, token_ok, status, raw, created_at)
       values ($1, 'POST', 'application/json', true, 200, $2::jsonb, now())`,
      source, JSON.stringify(body),
    ).catch(() => undefined);
  }

  private checkRateLimit(tenantId: string) {
    const now = Date.now();
    const current = this.limits.get(tenantId);
    if (!current || now - current.startedAt >= 60_000) {
      this.limits.set(tenantId, { startedAt: now, count: 1 });
      return;
    }
    current.count += 1;
    if (current.count > this.maxPerMinute) throw new HttpException('Webhook rate limit exceeded', HttpStatus.TOO_MANY_REQUESTS);
  }
}
