import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { IsEmail, IsOptional, IsString } from 'class-validator';
import { AuthGuard } from '../auth/auth.guard';
import { TenantGuard } from '../auth/tenant.guard';
import { PermissionsGuard, RequirePermissions } from '../auth/permissions.guard';
import { PERMISSIONS } from '../auth/permissions';
import { CurrentTenant, CurrentUser } from '../auth/decorators';
import type { ActiveTenant, AuthUser } from '../auth/auth.types';
import { CustomersService } from './customers.service';
import { AuditService } from '../audit/audit.service';

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
  ) {
    return this.customers.list(tenant.id, {
      search,
      page: Number(page) || undefined,
      pageSize: Number(pageSize) || undefined,
      missingRegistration: missingRegistration === 'true',
    });
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
  get360(@CurrentTenant() tenant: ActiveTenant, @Param('id') id: string) {
    return this.customers.get360(tenant.id, id);
  }

  @Get(':id/transactions')
  @RequirePermissions(PERMISSIONS.customersRead)
  transactions(
    @CurrentTenant() tenant: ActiveTenant,
    @Param('id') id: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.customers.transactionsFor(tenant.id, id, { page: Number(page) || undefined, pageSize: Number(pageSize) || undefined });
  }
}
