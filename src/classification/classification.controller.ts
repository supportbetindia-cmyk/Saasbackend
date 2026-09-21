import { Controller, Get, Post, UseGuards } from '@nestjs/common';
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
}
