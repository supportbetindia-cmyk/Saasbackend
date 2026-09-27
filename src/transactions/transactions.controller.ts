import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { IsNumber, IsOptional, IsString } from 'class-validator';
import { AuthGuard } from '../auth/auth.guard';
import { TenantGuard } from '../auth/tenant.guard';
import { PermissionsGuard, RequirePermissions } from '../auth/permissions.guard';
import { PERMISSIONS } from '../auth/permissions';
import { CurrentTenant, CurrentUser } from '../auth/decorators';
import type { ActiveTenant, AuthUser } from '../auth/auth.types';
import { TransactionsService } from './transactions.service';
import { AuditService } from '../audit/audit.service';
import { MasterIdPipe } from '../customers/master-scope';

class IngestTransactionDto {
  @IsOptional() @IsString() externalUserId?: string;
  @IsOptional() @IsString() masterId?: string;
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() phone?: string;
  @IsOptional() @IsString() email?: string;
  @IsOptional() @IsString() externalTransactionId?: string;
  @IsOptional() @IsString() source?: string;
  @IsString() transactionType!: string;
  @IsNumber() amount!: number;
  @IsOptional() @IsString() currency?: string;
  @IsOptional() @IsString() occurredAt?: string;
  @IsOptional() @IsString() status?: string;
  @IsOptional() @IsString() remarks?: string;
}

@Controller('transactions')
@UseGuards(AuthGuard, TenantGuard, PermissionsGuard)
export class TransactionsController {
  constructor(
    private readonly transactions: TransactionsService,
    private readonly audit: AuditService,
  ) {}

  // KPI summary + recent rows for the Transactions page. `from`/`to` are epoch ms
  // (computed client-side from the IST range picker); `from` omitted = all time.
  @Get('summary')
  @RequirePermissions(PERMISSIONS.transactionsRead)
  summary(
    @CurrentTenant() tenant: ActiveTenant,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('masterId', MasterIdPipe) masterId?: string,
  ) {
    const fromMs = from ? Number(from) : null;
    const toMs = to ? Number(to) : Date.now();
    return this.transactions.summary(tenant.id, Number.isFinite(fromMs as number) ? fromMs : null, toMs, masterId);
  }

  @Get()
  @RequirePermissions(PERMISSIONS.transactionsRead)
  list(
    @CurrentTenant() tenant: ActiveTenant,
    @Query('type') type?: string,
    @Query('status') status?: string,
    @Query('search') search?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('masterId', MasterIdPipe) masterId?: string,
  ) {
    return this.transactions.list(tenant.id, { type, status, search, masterId, page: Number(page) || undefined, pageSize: Number(pageSize) || undefined });
  }

  @Post()
  @RequirePermissions(PERMISSIONS.transactionsWrite)
  async ingest(@CurrentTenant() tenant: ActiveTenant, @CurrentUser() user: AuthUser, @Body() dto: IngestTransactionDto) {
    const txn = await this.transactions.ingest(tenant.id, dto);
    await this.audit.log({
      tenantId: tenant.id, actorUserId: user.id, action: 'transaction.ingested',
      entityType: 'transaction', entityId: txn.id,
      newValue: { type: txn.transactionType, amount: String(txn.amount), status: txn.normalizedStatus },
    });
    return txn;
  }
}
