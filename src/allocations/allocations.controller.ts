import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { IsBoolean, IsNumber, IsOptional, IsString, Max, Min } from 'class-validator';
import { AuthGuard } from '../auth/auth.guard';
import { TenantGuard } from '../auth/tenant.guard';
import { PermissionsGuard, RequirePermissions } from '../auth/permissions.guard';
import { PERMISSIONS } from '../auth/permissions';
import { CurrentTenant, CurrentUser } from '../auth/decorators';
import type { ActiveTenant, AuthUser } from '../auth/auth.types';
import { AuditService } from '../audit/audit.service';
import { AllocationsService } from './allocations.service';
import type { PeriodKey } from '../dashboard/periods';

const PERIODS: PeriodKey[] = ['today', 'week', 'month', 'quarter', 'year'];

class CreateDto {
  @IsString() name!: string;
  @IsNumber() @Min(0) @Max(100) percent!: number;
  @IsOptional() @IsBoolean() isRetained?: boolean;
}
class UpdateDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsNumber() @Min(0) @Max(100) percent?: number;
}

@Controller('allocations')
@UseGuards(AuthGuard, TenantGuard, PermissionsGuard)
export class AllocationsController {
  constructor(private readonly allocations: AllocationsService, private readonly audit: AuditService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.allocationsRead)
  plan(@CurrentTenant() tenant: ActiveTenant, @Query('period') period?: string) {
    const key: PeriodKey = PERIODS.includes(period as PeriodKey) ? (period as PeriodKey) : 'month';
    return this.allocations.plan(tenant.id, key);
  }

  @Post()
  @RequirePermissions(PERMISSIONS.allocationsManage)
  async create(@CurrentTenant() tenant: ActiveTenant, @CurrentUser() user: AuthUser, @Body() dto: CreateDto) {
    const row = await this.allocations.create(tenant.id, dto.name, dto.percent, dto.isRetained ?? false);
    await this.audit.log({ tenantId: tenant.id, actorUserId: user.id, action: 'allocation.created', entityType: 'allocation', entityId: row.id, newValue: dto });
    return row;
  }

  @Patch(':id')
  @RequirePermissions(PERMISSIONS.allocationsManage)
  async update(@CurrentTenant() tenant: ActiveTenant, @CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: UpdateDto) {
    const row = await this.allocations.update(tenant.id, id, dto);
    await this.audit.log({ tenantId: tenant.id, actorUserId: user.id, action: 'allocation.updated', entityType: 'allocation', entityId: id, newValue: dto });
    return row;
  }

  @Delete(':id')
  @RequirePermissions(PERMISSIONS.allocationsManage)
  async remove(@CurrentTenant() tenant: ActiveTenant, @CurrentUser() user: AuthUser, @Param('id') id: string) {
    await this.audit.log({ tenantId: tenant.id, actorUserId: user.id, action: 'allocation.removed', entityType: 'allocation', entityId: id });
    return this.allocations.remove(tenant.id, id);
  }
}
