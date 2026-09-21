import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AuthGuard } from '../auth/auth.guard';
import { TenantGuard } from '../auth/tenant.guard';
import { PermissionsGuard, RequirePermissions } from '../auth/permissions.guard';
import { CurrentUser, CurrentTenant, CurrentMembership } from '../auth/decorators';
import { PERMISSIONS } from '../auth/permissions';
import type { AuthUser, ActiveTenant, ActiveMembership } from '../auth/auth.types';
import { createWebhookSecret } from '../webhooks/webhook-secret';

class CreateTenantDto {
  @IsString() @IsNotEmpty() name!: string;
  @IsOptional() @IsString() timezone?: string;
  @IsOptional() @IsString() currency?: string;
}

@Controller('tenants')
export class TenantsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // Create a company/tenant; the creator becomes its OWNER.
  @Post()
  @UseGuards(AuthGuard)
  async create(@CurrentUser() user: AuthUser, @Body() dto: CreateTenantDto) {
    const tenant = await this.prisma.tenant.create({
      data: {
        name: dto.name,
        timezone: dto.timezone || 'Asia/Kolkata',
        currency: dto.currency || 'INR',
        memberships: { create: { userId: user.id, role: 'OWNER', status: 'ACTIVE' } },
      },
    });
    await this.audit.log({
      tenantId: tenant.id, actorUserId: user.id, action: 'tenant.created',
      entityType: 'tenant', entityId: tenant.id, newValue: { name: tenant.name },
    });
    return tenant;
  }

  // Tenants the current user belongs to.
  @Get()
  @UseGuards(AuthGuard)
  async myTenants(@CurrentUser() user: AuthUser) {
    const memberships = await this.prisma.tenantMembership.findMany({
      where: { userId: user.id },
      include: { tenant: true },
    });
    return memberships.map((m) => ({ id: m.tenant.id, name: m.tenant.name, role: m.role, status: m.status }));
  }

  // Example tenant-scoped, permission-gated endpoint (proves the full guard stack).
  @Get('current')
  @UseGuards(AuthGuard, TenantGuard, PermissionsGuard)
  @RequirePermissions(PERMISSIONS.customersRead)
  current(@CurrentTenant() tenant: ActiveTenant, @CurrentMembership() membership: ActiveMembership) {
    return { tenant, role: membership.role };
  }

  @Get('current/webhooks')
  @UseGuards(AuthGuard, TenantGuard, PermissionsGuard)
  @RequirePermissions(PERMISSIONS.integrationsManage)
  async webhooks(@CurrentTenant() tenant: ActiveTenant) {
    const value = await this.prisma.tenant.findUniqueOrThrow({
      where: { id: tenant.id },
      select: { webhookKey: true, webhookEnabled: true, webhookSecretHash: true },
    });
    return {
      webhookKey: value.webhookKey,
      enabled: value.webhookEnabled,
      configured: Boolean(value.webhookSecretHash),
      depositPath: `/api/v1/webhooks/${value.webhookKey}/deposit`,
      withdrawalPath: `/api/v1/webhooks/${value.webhookKey}/withdrawal`,
    };
  }

  @Post('current/webhooks/rotate')
  @UseGuards(AuthGuard, TenantGuard, PermissionsGuard)
  @RequirePermissions(PERMISSIONS.integrationsManage)
  async rotateWebhookSecret(@CurrentTenant() tenant: ActiveTenant, @CurrentUser() user: AuthUser) {
    const generated = createWebhookSecret();
    const value = await this.prisma.tenant.update({
      where: { id: tenant.id },
      data: { webhookSecretHash: generated.hash, webhookEnabled: true },
      select: { webhookKey: true },
    });
    await this.audit.log({
      tenantId: tenant.id, actorUserId: user.id, action: 'webhook.secret.rotated',
      entityType: 'tenant', entityId: tenant.id,
    });
    return {
      secret: generated.secret,
      depositPath: `/api/v1/webhooks/${value.webhookKey}/deposit`,
      withdrawalPath: `/api/v1/webhooks/${value.webhookKey}/withdrawal`,
    };
  }
}
