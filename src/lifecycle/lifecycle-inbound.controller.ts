import { BadRequestException, Body, Controller, Headers, Param, Post, Query, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { verifyWebhookSecret } from '../webhooks/webhook-secret';
import { LifecycleInboundService } from './lifecycle-inbound.service';

// Interakt posts delivery status + inbound replies here. Configure the URL in Interakt as
//   https://api.betindia.games/api/v1/webhooks/interakt/<webhookKey>?token=<secret>
// (same key/secret pair as the Get-ID webhook). Public route — auth is the secret.
@Controller('webhooks/interakt')
export class LifecycleInboundController {
  constructor(private readonly prisma: PrismaService, private readonly inbound: LifecycleInboundService) {}

  @Post(':webhookKey')
  async receive(
    @Param('webhookKey') webhookKey: string,
    @Headers('x-webhook-secret') headerSecret: string | undefined,
    @Query('token') token: string | undefined,
    @Body() body: Record<string, unknown>,
  ) {
    const tenant = await this.prisma.tenant.findFirst({ where: { webhookKey, status: 'ACTIVE', webhookEnabled: true } });
    if (!tenant) throw new BadRequestException('Unknown or inactive tenant');
    if (!verifyWebhookSecret(headerSecret || token, tenant.webhookSecretHash)) throw new UnauthorizedException('Invalid webhook secret');
    return this.inbound.handle(tenant.id, body ?? {});
  }
}
