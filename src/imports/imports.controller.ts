import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsNumber, IsOptional, IsString, ValidateNested } from 'class-validator';
import { AuthGuard } from '../auth/auth.guard';
import { TenantGuard } from '../auth/tenant.guard';
import { PermissionsGuard, RequirePermissions } from '../auth/permissions.guard';
import { PERMISSIONS } from '../auth/permissions';
import { CurrentTenant, CurrentUser } from '../auth/decorators';
import type { ActiveTenant, AuthUser } from '../auth/auth.types';
import { AuditService } from '../audit/audit.service';
import { ClassificationService } from '../classification/classification.service';
import { ImportsService } from './imports.service';

class CsvCustomerRowDto {
  @IsString() externalUserId!: string;
  @IsOptional() @IsString() masterId?: string | null;
  @IsOptional() @IsString() name?: string | null;
  @IsOptional() @IsString() phone?: string | null;
  @IsOptional() @IsString() registrationAt?: string | null;
  @IsOptional() @IsString() accountStatus?: string | null;
  @IsOptional() @IsString() currentCategory?: string | null;
  @IsOptional() @IsString() ftdDate?: string | null;
  @IsOptional() @IsNumber() ftdAmount?: number | null;
  @IsOptional() @IsNumber() totalDeposits?: number | null;
  @IsOptional() @IsNumber() depositCount?: number | null;
  @IsOptional() @IsNumber() totalWithdrawals?: number | null;
  @IsOptional() @IsNumber() withdrawalCount?: number | null;
  @IsOptional() @IsNumber() netPnl?: number | null;
  @IsOptional() @IsNumber() totalBonus?: number | null;
  @IsOptional() @IsString() lastDepositAt?: string | null;
  @IsOptional() @IsNumber() lastDepositAmount?: number | null;
  @IsOptional() @IsString() lastWithdrawalAt?: string | null;
  @IsOptional() @IsNumber() lastWithdrawalAmount?: number | null;
}

class ImportCustomersDto {
  @IsArray()
  @ArrayMaxSize(100000)
  @ValidateNested({ each: true })
  @Type(() => CsvCustomerRowDto)
  rows!: CsvCustomerRowDto[];
}

@Controller('imports')
@UseGuards(AuthGuard, TenantGuard, PermissionsGuard)
export class ImportsController {
  constructor(
    private readonly imports: ImportsService,
    private readonly audit: AuditService,
    private readonly classification: ClassificationService,
  ) {}

  @Post('legacy/customers')
  @RequirePermissions(PERMISSIONS.importsCommit)
  async importLegacyCustomers(
    @CurrentTenant() tenant: ActiveTenant,
    @CurrentUser() user: AuthUser,
  ) {
    const result = await this.imports.importLegacyCustomers(tenant.id, tenant.name);
    // Freshly imported numbers → reclassify so lifecycle/tier are never stale.
    const classification = await this.classification.recomputeTenant(tenant.id);
    await this.audit.log({
      tenantId: tenant.id,
      actorUserId: user.id,
      action: 'legacy.customers.imported',
      entityType: 'import',
      newValue: { ...result, classification },
    });
    return { ...result, classification };
  }

  @Post('customers')
  @RequirePermissions(PERMISSIONS.importsCommit)
  async importCustomers(
    @CurrentTenant() tenant: ActiveTenant,
    @CurrentUser() user: AuthUser,
    @Body() dto: ImportCustomersDto,
  ) {
    const result = await this.imports.importCustomerRows(tenant.id, dto.rows);
    const classification = await this.classification.recomputeTenant(tenant.id);
    await this.audit.log({
      tenantId: tenant.id,
      actorUserId: user.id,
      action: 'customers.csv.imported',
      entityType: 'import',
      newValue: { ...result, classification },
    });
    return { ...result, classification };
  }

  @Post('legacy/transactions')
  @RequirePermissions(PERMISSIONS.importsCommit)
  async importLegacyTransactions(
    @CurrentTenant() tenant: ActiveTenant,
    @CurrentUser() user: AuthUser,
  ) {
    const result = await this.imports.importLegacyTransactions(tenant.id, tenant.name);
    await this.audit.log({
      tenantId: tenant.id,
      actorUserId: user.id,
      action: 'legacy.transactions.imported',
      entityType: 'import',
      newValue: result,
    });
    return result;
  }
}

