import { BadRequestException, Body, Controller, Headers, HttpException, HttpStatus, Param, Post, Query, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { TransactionsService } from '../transactions/transactions.service';
import { WhatsappService } from '../whatsapp/whatsapp.service';
import { normalizeType } from '../transactions/status';
import { mapWebhook, webhookFingerprint, type WebhookType } from './webhook.mapper';
import { verifyWebhookSecret } from './webhook-secret';

@Controller('webhooks')
export class WebhooksController {
  // ponytail: process-local limiter; move to the API gateway/Redis when the backend runs on multiple instances.
  private readonly limits = new Map<string, { startedAt: number; count: number }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly transactions: TransactionsService,
    private readonly whatsapp: WhatsappService,
  ) {}

  // One endpoint for deposit, withdrawal, AND update. The provider sends the secret
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
    if (rawType !== 'deposit' && rawType !== 'withdrawal' && rawType !== 'update') {
      throw new BadRequestException('type must be deposit, withdrawal or update');
    }
    const tenant = await this.prisma.tenant.findFirst({ where: { webhookKey, status: 'ACTIVE', webhookEnabled: true } });
    if (!tenant) throw new BadRequestException('Unknown or inactive tenant');
    this.checkRateLimit(tenant.id);
    if (!verifyWebhookSecret(headerSecret || token, tenant.webhookSecretHash)) throw new UnauthorizedException('Invalid webhook secret');

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

  private checkRateLimit(tenantId: string) {
    const now = Date.now();
    const current = this.limits.get(tenantId);
    if (!current || now - current.startedAt >= 60_000) {
      this.limits.set(tenantId, { startedAt: now, count: 1 });
      return;
    }
    current.count += 1;
    if (current.count > 120) throw new HttpException('Webhook rate limit exceeded', HttpStatus.TOO_MANY_REQUESTS);
  }
}
