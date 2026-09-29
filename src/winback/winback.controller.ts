import { Controller, Get, Post, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { TenantGuard } from '../auth/tenant.guard';
import { PermissionsGuard, RequirePermissions } from '../auth/permissions.guard';
import { PERMISSIONS } from '../auth/permissions';
import { CurrentTenant, CurrentUser } from '../auth/decorators';
import type { ActiveTenant, AuthUser } from '../auth/auth.types';
import { AuditService } from '../audit/audit.service';
import { WinbackService } from './winback.service';

@Controller('winback')
@UseGuards(AuthGuard, TenantGuard, PermissionsGuard)
export class WinbackController {
  constructor(private readonly winback: WinbackService, private readonly audit: AuditService) {}

  // How many inactive players are eligible right now, and whether it's configured.
  @Get('preview')
  @RequirePermissions(PERMISSIONS.whatsappRead)
  preview(@CurrentTenant() tenant: ActiveTenant) {
    return this.winback.preview(tenant.id);
  }

  // Send the win-back now for the selected company (respects the 7-day cooldown).
  @Post('run')
  @RequirePermissions(PERMISSIONS.whatsappManage)
  async run(@CurrentTenant() tenant: ActiveTenant, @CurrentUser() user: AuthUser) {
    const result = await this.winback.runTenant(tenant.id);
    await this.audit.log({
      tenantId: tenant.id, actorUserId: user.id, action: 'winback.run',
      entityType: 'winback', newValue: result,
    });
    return result;
  }
}
