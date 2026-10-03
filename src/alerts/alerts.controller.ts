import { Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { TenantGuard } from '../auth/tenant.guard';
import { PermissionsGuard, RequirePermissions } from '../auth/permissions.guard';
import { PERMISSIONS } from '../auth/permissions';
import { CurrentTenant } from '../auth/decorators';
import type { ActiveTenant } from '../auth/auth.types';
import { AlertsService } from './alerts.service';

@Controller('alerts')
@UseGuards(AuthGuard, TenantGuard, PermissionsGuard)
export class AlertsController {
  constructor(private readonly alerts: AlertsService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.customersRead)
  list(@CurrentTenant() tenant: ActiveTenant, @Query('unacked') unacked?: string) {
    return this.alerts.list(tenant.id, unacked === 'true');
  }

  // Run the detection rules now (also runs hourly when ALERTS_ENABLED=1).
  @Post('run')
  @RequirePermissions(PERMISSIONS.customersWrite)
  run(@CurrentTenant() tenant: ActiveTenant) {
    return this.alerts.runTenant(tenant.id);
  }

  @Post(':id/ack')
  @RequirePermissions(PERMISSIONS.customersWrite)
  ack(@CurrentTenant() tenant: ActiveTenant, @Param('id') id: string) {
    return this.alerts.ack(tenant.id, id);
  }
}
