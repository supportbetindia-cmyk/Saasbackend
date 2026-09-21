import { BadRequestException, Body, Controller, Headers, HttpException, HttpStatus, Param, Post, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { TransactionsService } from '../transactions/transactions.service';
import { mapWebhook, webhookFingerprint, type WebhookType } from './webhook.mapper';
import { verifyWebhookSecret } from './webhook-secret';

@Controller('webhooks')
export class WebhooksController {
  // ponytail: process-local limiter; move to the API gateway/Redis when the backend runs on multiple instances.
  private readonly limits = new Map<string, { startedAt: number; count: number }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly transactions: TransactionsService,
  ) {}

  @Post(':webhookKey/:type')
  async receive(
    @Param('webhookKey') webhookKey: string,
    @Param('type') rawType: string,
    @Headers('x-webhook-secret') secret: string | undefined,
    @Body() body: Record<string, unknown>,
  ) {
    if (rawType !== 'deposit' && rawType !== 'withdrawal') {
      throw new BadRequestException('type must be deposit or withdrawal');
    }
    const tenant = await this.prisma.tenant.findFirst({ where: { webhookKey, status: 'ACTIVE', webhookEnabled: true } });
    if (!tenant) throw new BadRequestException('Unknown or inactive tenant');
    this.checkRateLimit(tenant.id);
    if (!verifyWebhookSecret(secret, tenant.webhookSecretHash)) throw new UnauthorizedException('Invalid webhook secret');

    let input;
    try {
      input = mapWebhook(rawType as WebhookType, body);
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : 'Invalid webhook payload');
    }
    const fingerprint = webhookFingerprint(rawType as WebhookType, input, body);
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
          eventType: rawType, payloadHash: fingerprint.payloadHash,
          processingStatus: 'processed', processedAt: new Date(),
        },
      });
      return { ok: true, transactionId: transaction.id };
    } catch (error) {
      await this.prisma.webhookEvent.upsert({
        where: { tenantId_provider_externalEventId: { tenantId: tenant.id, provider: 'wati', externalEventId: fingerprint.eventId } },
        update: { payloadHash: fingerprint.payloadHash, processingStatus: 'failed', error: error instanceof Error ? error.message : String(error) },
        create: {
          tenantId: tenant.id, provider: 'wati', externalEventId: fingerprint.eventId,
          eventType: rawType, payloadHash: fingerprint.payloadHash,
          processingStatus: 'failed', error: error instanceof Error ? error.message : String(error),
        },
      });
      throw error;
    }
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
