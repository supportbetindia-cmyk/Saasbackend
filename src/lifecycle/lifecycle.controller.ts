import { Controller, Get, Post, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { TenantGuard } from '../auth/tenant.guard';
import { PermissionsGuard, RequirePermissions } from '../auth/permissions.guard';
import { PERMISSIONS } from '../auth/permissions';
import { CurrentTenant, CurrentUser } from '../auth/decorators';
import type { ActiveTenant, AuthUser } from '../auth/auth.types';
import { AuditService } from '../audit/audit.service';
import { LifecycleService } from './lifecycle.service';

@Controller('lifecycle')
@UseGuards(AuthGuard, TenantGuard, PermissionsGuard)
export class LifecycleController {
  constructor(private readonly lifecycle: LifecycleService, private readonly audit: AuditService) {}

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
}
