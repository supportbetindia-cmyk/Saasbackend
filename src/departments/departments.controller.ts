import { Body, Controller, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { ArrayNotEmpty, IsArray, IsBoolean, IsString, Length } from 'class-validator';
import { AuditService } from '../audit/audit.service';
import { AuthGuard } from '../auth/auth.guard';
import { TenantGuard } from '../auth/tenant.guard';
import { PermissionsGuard, RequirePermissions } from '../auth/permissions.guard';
import { PERMISSIONS } from '../auth/permissions';
import { CurrentTenant, CurrentUser } from '../auth/decorators';
import type { ActiveTenant, AuthUser } from '../auth/auth.types';
import { DepartmentsService } from './departments.service';

class NameDto { @IsString() @Length(1, 100) name!: string; }
class ArchiveDto { @IsBoolean() archived!: boolean; }
class ReorderDto { @IsArray() @ArrayNotEmpty() @IsString({ each: true }) ids!: string[]; }

@Controller('departments')
@UseGuards(AuthGuard, TenantGuard, PermissionsGuard)
export class DepartmentsController {
  constructor(private readonly departments: DepartmentsService, private readonly audit: AuditService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.allocationsRead)
  list(@CurrentTenant() tenant: ActiveTenant) { return this.departments.list(tenant.id); }

  @Post()
  @RequirePermissions(PERMISSIONS.allocationsManage)
  async create(@CurrentTenant() tenant: ActiveTenant, @CurrentUser() user: AuthUser, @Body() dto: NameDto) {
    const value = await this.departments.create(tenant.id, dto.name);
    await this.audit.log({ tenantId: tenant.id, actorUserId: user.id, action: 'department.created', entityType: 'department', entityId: value.id, newValue: { name: value.name } });
    return value;
  }

  @Patch('reorder')
  @RequirePermissions(PERMISSIONS.allocationsManage)
  async reorder(@CurrentTenant() tenant: ActiveTenant, @CurrentUser() user: AuthUser, @Body() dto: ReorderDto) {
    const value = await this.departments.reorder(tenant.id, dto.ids);
    await this.audit.log({ tenantId: tenant.id, actorUserId: user.id, action: 'departments.reordered', entityType: 'department', newValue: { ids: dto.ids } });
    return value;
  }

  @Patch(':id')
  @RequirePermissions(PERMISSIONS.allocationsManage)
  async rename(@Param('id') id: string, @CurrentTenant() tenant: ActiveTenant, @CurrentUser() user: AuthUser, @Body() dto: NameDto) {
    const result = await this.departments.rename(tenant.id, id, dto.name);
    await this.audit.log({ tenantId: tenant.id, actorUserId: user.id, action: 'department.renamed', entityType: 'department', entityId: id, oldValue: { name: result.old.name }, newValue: { name: result.value.name } });
    return result.value;
  }

  @Patch(':id/archive')
  @RequirePermissions(PERMISSIONS.allocationsManage)
  async archive(@Param('id') id: string, @CurrentTenant() tenant: ActiveTenant, @CurrentUser() user: AuthUser, @Body() dto: ArchiveDto) {
    const result = await this.departments.setArchived(tenant.id, id, dto.archived);
    await this.audit.log({ tenantId: tenant.id, actorUserId: user.id, action: dto.archived ? 'department.archived' : 'department.restored', entityType: 'department', entityId: id, oldValue: { archivedAt: result.old.archivedAt }, newValue: { archivedAt: result.value.archivedAt } });
    return result.value;
  }
}
