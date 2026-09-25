import { Body, Controller, Get, Post, Put, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { TenantGuard } from '../auth/tenant.guard';
import { PermissionsGuard, RequirePermissions } from '../auth/permissions.guard';
import { PERMISSIONS } from '../auth/permissions';
import { CurrentTenant, CurrentUser } from '../auth/decorators';
import type { ActiveTenant, AuthUser } from '../auth/auth.types';
import { AuditService } from '../audit/audit.service';
import { ClassificationService } from './classification.service';

@Controller('classification')
@UseGuards(AuthGuard, TenantGuard, PermissionsGuard)
export class ClassificationController {
  constructor(
    private readonly classification: ClassificationService,
    private readonly audit: AuditService,
  ) {}

  @Post('recompute')
  @RequirePermissions(PERMISSIONS.customersWrite)
  async recompute(@CurrentTenant() tenant: ActiveTenant, @CurrentUser() user: AuthUser) {
    const result = await this.classification.recomputeTenant(tenant.id);
    await this.audit.log({
      tenantId: tenant.id, actorUserId: user.id, action: 'classification.recomputed',
      entityType: 'classification', newValue: result,
    });
    return result;
  }

  @Get('summary')
  @RequirePermissions(PERMISSIONS.customersRead)
  summary(@CurrentTenant() tenant: ActiveTenant) {
    return this.classification.summary(tenant.id);
  }

  @Get('schedule')
  @RequirePermissions(PERMISSIONS.customersRead)
  schedule(@CurrentTenant() tenant: ActiveTenant) {
    return this.classification.scheduleStatus(tenant.id);
  }

  // The tenant's editable classification thresholds (Admin panel).
  @Get('config')
  @RequirePermissions(PERMISSIONS.customersRead)
  getConfig(@CurrentTenant() tenant: ActiveTenant) {
    return this.classification.getConfig(tenant.id);
  }

  @Put('config')
  @RequirePermissions(PERMISSIONS.customersWrite)
  async saveConfig(@CurrentTenant() tenant: ActiveTenant, @CurrentUser() user: AuthUser, @Body() body: unknown) {
    const cfg = await this.classification.saveConfig(tenant.id, body);
    await this.audit.log({
      tenantId: tenant.id, actorUserId: user.id, action: 'classification.config_updated',
      entityType: 'classification', newValue: cfg as unknown as Record<string, unknown>,
    });
    return cfg;
  }
}
