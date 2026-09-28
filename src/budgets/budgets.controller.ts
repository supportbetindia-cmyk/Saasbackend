import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { IsNumber, IsString, Matches, Min } from 'class-validator';
import { AuthGuard } from '../auth/auth.guard';
import { TenantGuard } from '../auth/tenant.guard';
import { PermissionsGuard, RequirePermissions } from '../auth/permissions.guard';
import { PERMISSIONS } from '../auth/permissions';
import { CurrentTenant, CurrentUser } from '../auth/decorators';
import type { ActiveTenant, AuthUser } from '../auth/auth.types';
import { AuditService } from '../audit/audit.service';
import { BudgetsService } from './budgets.service';

class SetBudgetDto {
  @IsString() departmentId!: string;
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, { message: 'period must be YYYY-MM' }) period!: string;
  @IsNumber() @Min(0) budgetAmount!: number;
  @IsNumber() @Min(0) actualAmount!: number;
}

@Controller('budgets')
@UseGuards(AuthGuard, TenantGuard, PermissionsGuard)
export class BudgetsController {
  constructor(private readonly budgets: BudgetsService, private readonly audit: AuditService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.budgetsRead)
  list(@CurrentTenant() tenant: ActiveTenant, @Query('period') period?: string) {
    return this.budgets.list(tenant.id, period || currentMonth());
  }

  @Post()
  @RequirePermissions(PERMISSIONS.budgetsManage)
  async set(@CurrentTenant() tenant: ActiveTenant, @CurrentUser() user: AuthUser, @Body() dto: SetBudgetDto) {
    const result = await this.budgets.upsert(tenant.id, dto.departmentId, dto.period, dto.budgetAmount, dto.actualAmount);
    await this.audit.log({
      tenantId: tenant.id, actorUserId: user.id, action: 'budget.set',
      entityType: 'budget', entityId: result.id, newValue: dto,
    });
    return result;
  }
}

// Fallback period when the client doesn't pass one (client always sends the picked month).
function currentMonth(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
