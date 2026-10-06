import { Body, Controller, Delete, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { MasterId, MasterScoped } from '../customers/master-scope';
import { IsIn, IsNumber, Min } from 'class-validator';
import { AuthGuard } from '../auth/auth.guard';
import { TenantGuard } from '../auth/tenant.guard';
import { PermissionsGuard, RequirePermissions } from '../auth/permissions.guard';
import { PERMISSIONS } from '../auth/permissions';
import { CurrentTenant, CurrentUser } from '../auth/decorators';
import type { ActiveTenant, AuthUser } from '../auth/auth.types';
import { AuditService } from '../audit/audit.service';
import { TargetsService, TARGET_METRICS, TARGET_PERIODS } from './targets.service';

class SetTargetDto {
  @IsIn(TARGET_METRICS as unknown as string[]) metric!: string;
  @IsIn(TARGET_PERIODS as unknown as string[]) period!: string;
  @IsNumber() @Min(0) targetValue!: number;
}

@Controller('targets')
@UseGuards(AuthGuard, TenantGuard, PermissionsGuard)
export class TargetsController {
  constructor(private readonly targets: TargetsService, private readonly audit: AuditService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.targetsRead)
  @MasterScoped()
  list(@CurrentTenant() tenant: ActiveTenant, @MasterId() masterId?: string) {
    return this.targets.listWithProgress(tenant.id, masterId);
  }

  @Post()
  @RequirePermissions(PERMISSIONS.targetsManage)
  async set(@CurrentTenant() tenant: ActiveTenant, @CurrentUser() user: AuthUser, @Body() dto: SetTargetDto) {
    const result = await this.targets.upsert(tenant.id, dto.metric, dto.period, dto.targetValue);
    await this.audit.log({
      tenantId: tenant.id, actorUserId: user.id, action: 'target.set',
      entityType: 'target', entityId: result.id, newValue: dto,
    });
    return result;
  }

  @Delete(':id')
  @RequirePermissions(PERMISSIONS.targetsManage)
  async remove(@CurrentTenant() tenant: ActiveTenant, @CurrentUser() user: AuthUser, @Param('id') id: string) {
    await this.audit.log({ tenantId: tenant.id, actorUserId: user.id, action: 'target.removed', entityType: 'target', entityId: id });
    return this.targets.remove(tenant.id, id);
  }
}
