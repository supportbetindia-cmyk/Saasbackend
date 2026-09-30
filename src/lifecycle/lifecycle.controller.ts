import { Body, Controller, Get, Post, Put, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { TenantGuard } from '../auth/tenant.guard';
import { PermissionsGuard, RequirePermissions } from '../auth/permissions.guard';
import { PERMISSIONS } from '../auth/permissions';
import { CurrentTenant, CurrentUser } from '../auth/decorators';
import type { ActiveTenant, AuthUser } from '../auth/auth.types';
import { AuditService } from '../audit/audit.service';
import { LifecycleService } from './lifecycle.service';
import { LifecycleSenderService } from './lifecycle-sender.service';

@Controller('lifecycle')
@UseGuards(AuthGuard, TenantGuard, PermissionsGuard)
export class LifecycleController {
  constructor(
    private readonly lifecycle: LifecycleService,
    private readonly sender: LifecycleSenderService,
    private readonly audit: AuditService,
  ) {}

  // How many customers are in each stage right now.
  @Get('summary')
  @RequirePermissions(PERMISSIONS.customersRead)
  summary(@CurrentTenant() tenant: ActiveTenant) {
    return this.lifecycle.summary(tenant.id);
  }

  // Recompute every customer's stage now (also runs automatically via LiveSync).
  @Post('recompute')
  @RequirePermissions(PERMISSIONS.customersWrite)
  async recompute(@CurrentTenant() tenant: ActiveTenant, @CurrentUser() user: AuthUser) {
    const result = await this.lifecycle.recomputeTenant(tenant.id, 'Manual recompute');
    await this.audit.log({
      tenantId: tenant.id, actorUserId: user.id, action: 'lifecycle.recomputed',
      entityType: 'lifecycle', newValue: result,
    });
    return result;
  }

  // The tenant's editable lifecycle thresholds.
  @Get('config')
  @RequirePermissions(PERMISSIONS.customersRead)
  getConfig(@CurrentTenant() tenant: ActiveTenant) {
    return this.lifecycle.getConfig(tenant.id);
  }

  @Put('config')
  @RequirePermissions(PERMISSIONS.customersWrite)
  async saveConfig(@CurrentTenant() tenant: ActiveTenant, @CurrentUser() user: AuthUser, @Body() body: unknown) {
    const cfg = await this.lifecycle.saveConfig(tenant.id, body);
    await this.audit.log({
      tenantId: tenant.id, actorUserId: user.id, action: 'lifecycle.config_updated',
      entityType: 'lifecycle', newValue: cfg as unknown as Record<string, unknown>,
    });
    return cfg;
  }

  // Eligible customers per stage right now (no sending).
  @Get('send/preview')
  @RequirePermissions(PERMISSIONS.whatsappRead)
  sendPreview(@CurrentTenant() tenant: ActiveTenant) {
    return this.sender.preview(tenant.id);
  }

  // Send this run's due lifecycle messages now (respects cooldown + caps).
  @Post('send/run')
  @RequirePermissions(PERMISSIONS.whatsappManage)
  async sendRun(@CurrentTenant() tenant: ActiveTenant, @CurrentUser() user: AuthUser) {
    const result = await this.sender.runTenant(tenant.id);
    await this.audit.log({
      tenantId: tenant.id, actorUserId: user.id, action: 'lifecycle.send_run',
      entityType: 'lifecycle', newValue: result as unknown as Record<string, unknown>,
    });
    return result;
  }
}
