import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { TenantGuard } from '../auth/tenant.guard';
import { PermissionsGuard, RequirePermissions } from '../auth/permissions.guard';
import { PERMISSIONS } from '../auth/permissions';
import { CurrentTenant } from '../auth/decorators';
import type { ActiveTenant } from '../auth/auth.types';
import { DashboardService } from './dashboard.service';
import type { PeriodKey } from './periods';

const PERIODS: PeriodKey[] = ['today', 'week', 'month', 'quarter', 'year', 'custom'];

@Controller('dashboard')
@UseGuards(AuthGuard, TenantGuard, PermissionsGuard)
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.financialDashboardRead)
  overview(
    @CurrentTenant() tenant: ActiveTenant,
    @Query('period') period?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const key: PeriodKey = PERIODS.includes(period as PeriodKey) ? (period as PeriodKey) : 'month';
    return this.dashboard.overview(tenant.id, key, from, to);
  }
}
