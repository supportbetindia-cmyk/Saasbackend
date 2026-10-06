import { BadRequestException, Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { MasterId, MasterScoped } from '../customers/master-scope';
import { AuthGuard } from '../auth/auth.guard';
import { TenantGuard } from '../auth/tenant.guard';
import { PermissionsGuard, RequirePermissions } from '../auth/permissions.guard';
import { PERMISSIONS } from '../auth/permissions';
import { CurrentTenant } from '../auth/decorators';
import type { ActiveTenant } from '../auth/auth.types';
import { ReportsService, type ReportType } from './reports.service';

@Controller('reports')
@UseGuards(AuthGuard, TenantGuard, PermissionsGuard)
@RequirePermissions(PERMISSIONS.reportsRead)
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get(':type')
  @MasterScoped()
  get(@CurrentTenant() tenant: ActiveTenant, @Param('type') type: string, @MasterId() masterId?: string) {
    if (!['daily', 'weekly', 'monthly'].includes(type)) throw new BadRequestException('type must be daily, weekly or monthly');
    return this.reports.get(tenant.id, type as ReportType, masterId);
  }
}
