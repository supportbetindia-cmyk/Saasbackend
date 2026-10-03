import { Body, Controller, Get, Header, Param, Post, Query, UseGuards } from '@nestjs/common';
import { IsEmail, IsOptional, IsString } from 'class-validator';
import { AuthGuard } from '../auth/auth.guard';
import { TenantGuard } from '../auth/tenant.guard';
import { PermissionsGuard, RequirePermissions } from '../auth/permissions.guard';
import { PERMISSIONS } from '../auth/permissions';
import { CurrentTenant, CurrentUser } from '../auth/decorators';
import type { ActiveTenant, AuthUser } from '../auth/auth.types';
import { CustomersService } from './customers.service';
import { AuditService } from '../audit/audit.service';
import { MasterIdPipe } from './master-scope';

class CreateCustomerDto {
  @IsOptional() @IsString() externalUserId?: string;
  @IsOptional() @IsString() masterId?: string;
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() phone?: string;
  @IsOptional() @IsEmail() email?: string;
  @IsOptional() @IsString() registrationAt?: string;
}

@Controller('customers')
@UseGuards(AuthGuard, TenantGuard, PermissionsGuard)
export class CustomersController {
  constructor(
    private readonly customers: CustomersService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @RequirePermissions(PERMISSIONS.customersRead)
  list(
    @CurrentTenant() tenant: ActiveTenant,
    @Query('search') search?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('missingRegistration') missingRegistration?: string,
    @Query('stage') stage?: string,
    @Query('activity') activity?: string,
    @Query('tier') tier?: string,
    @Query('quietDays') quietDays?: string,
    @Query('hasPhone') hasPhone?: string,
    @Query('masterId', MasterIdPipe) masterId?: string,
  ) {
    return this.customers.list(tenant.id, {
      search,
      masterId,
      stage,
      activity,
      tier,
      quietDays: Number(quietDays) || undefined,
      hasPhone: hasPhone === 'true',
      page: Number(page) || undefined,
      pageSize: Number(pageSize) || undefined,
      missingRegistration: missingRegistration === 'true',
    });
  }

  // CSV of all players matching the current filters. Declared before :id so the
  // router doesn't treat "export" as an id.
  @Get('export')
  @RequirePermissions(PERMISSIONS.customersExport)
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="players.csv"')
  exportCsv(
    @CurrentTenant() tenant: ActiveTenant,
    @Query('search') search?: string,
    @Query('missingRegistration') missingRegistration?: string,
    @Query('stage') stage?: string,
    @Query('activity') activity?: string,
    @Query('tier') tier?: string,
    @Query('quietDays') quietDays?: string,
    @Query('hasPhone') hasPhone?: string,
    @Query('masterId', MasterIdPipe) masterId?: string,
  ) {
    return this.customers.exportCsv(tenant.id, {
      search, stage, activity, tier, masterId,
      quietDays: Number(quietDays) || undefined,
      hasPhone: hasPhone === 'true',
      missingRegistration: missingRegistration === 'true',
    });
  }

  @Get('masters')
  @RequirePermissions(PERMISSIONS.customersRead)
  masters(@CurrentTenant() tenant: ActiveTenant) {
    return this.customers.masters(tenant.id);
  }

  @Post()
  @RequirePermissions(PERMISSIONS.customersWrite)
  async create(@CurrentTenant() tenant: ActiveTenant, @CurrentUser() user: AuthUser, @Body() dto: CreateCustomerDto) {
    const customer = await this.customers.upsertByExternal(tenant.id, dto);
    await this.audit.log({
      tenantId: tenant.id, actorUserId: user.id, action: 'customer.upserted',
      entityType: 'customer', entityId: customer.id, newValue: { externalUserId: customer.externalUserId, name: customer.name },
    });
    return customer;
  }

  @Get(':id')
  @RequirePermissions(PERMISSIONS.customersRead)
  get360(@CurrentTenant() tenant: ActiveTenant, @Param('id') id: string, @Query('masterId', MasterIdPipe) masterId?: string) {
    return this.customers.get360(tenant.id, id, masterId);
  }

  // AI-written summary + recommended next action (stats only, no PII).
  @Get(':id/ai-summary')
  @RequirePermissions(PERMISSIONS.customersRead)
  aiSummary(@CurrentTenant() tenant: ActiveTenant, @Param('id') id: string) {
    return this.customers.aiSummary(tenant.id, id);
  }

  @Get(':id/transactions')
  @RequirePermissions(PERMISSIONS.customersRead)
  transactions(
    @CurrentTenant() tenant: ActiveTenant,
    @Param('id') id: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('masterId', MasterIdPipe) masterId?: string,
  ) {
    return this.customers.transactionsFor(tenant.id, id, { page: Number(page) || undefined, pageSize: Number(pageSize) || undefined }, masterId);
  }
}
