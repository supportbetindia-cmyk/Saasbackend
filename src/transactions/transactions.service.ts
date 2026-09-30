import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma, type TransactionType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CustomersService } from '../customers/customers.service';
import { normalizeStatus, normalizeType } from './status';
import { transactionScope } from '../customers/master-scope';

export type IngestInput = {
  // customer identity (a customer is upserted from these)
  externalUserId?: string | null;
  masterId?: string | null;
  name?: string | null;
  phone?: string | null;
  email?: string | null;
  // transaction
  externalTransactionId?: string | null;
  source?: string | null;
  transactionType: string; // deposit | withdrawal
  amount: number;
  currency?: string | null;
  occurredAt?: string | Date | null;
  status?: string | null; // raw provider status
  remarks?: string | null;
};

@Injectable()
export class TransactionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly customers: CustomersService,
  ) {}

 
  async ingest(tenantId: string, input: IngestInput) {
    const type = normalizeType(input.transactionType);
    if (!type) throw new BadRequestException('transactionType must be deposit or withdrawal');
    if (!Number.isFinite(input.amount)) throw new BadRequestException('amount must be a number');

    const customer = await this.customers.upsertByExternal(tenantId, {
      externalUserId: input.externalUserId,
      masterId: input.masterId,
      name: input.name,
      phone: input.phone,
      email: input.email,
    });

    const { normalized, successful } = normalizeStatus(input.status);
    const source = input.source || 'manual';
    const occurredAt = input.occurredAt ? new Date(input.occurredAt) : new Date();
    const amount = new Prisma.Decimal(input.amount);

    const data = {
      tenantId,
      customerId: customer.id,
      externalTransactionId: input.externalTransactionId ?? null,
      source,
      transactionType: type,
      amount,
      currency: input.currency || 'INR',
      occurredAt,
      rawStatus: input.status ?? null,
      normalizedStatus: normalized,
      isFinanciallySuccessful: successful,
      remarks: input.remarks ?? null,
    };

    let txn;
    if (input.externalTransactionId) {
      txn = await this.prisma.transaction.upsert({
        where: {
          tenantId_source_externalTransactionId: {
            tenantId, source, externalTransactionId: input.externalTransactionId,
          },
        },
        update: {
          amount, currency: data.currency, occurredAt, rawStatus: data.rawStatus,
          normalizedStatus: normalized, isFinanciallySuccessful: successful, remarks: data.remarks,
          transactionType: type, customerId: customer.id,
        },
        create: data,
      });
    } else {
      txn = await this.prisma.transaction.create({ data });
    }

    if (type === 'DEPOSIT') await this.recomputeFtd(tenantId, customer.id);
    // Keep the "last deposit/withdrawal" marker live from webhooks (the imported
    // legacy aggregates froze once and never refresh on their own).
    await this.recomputeLastActivity(tenantId, customer.id, type);
    return txn;
  }

  /** Move the customer's last-deposit / last-withdrawal marker FORWARD to the newest
   * successful transaction. Forward-only: never moves it backward, because the
   * lifetime totals were imported from the legacy users table and stay authoritative —
   * we only refresh the "most recent activity" the live webhook now knows about. */
  async recomputeLastActivity(tenantId: string, customerId: string, type: 'DEPOSIT' | 'WITHDRAWAL'): Promise<void> {
    const last = await this.prisma.transaction.findFirst({
      where: { tenantId, customerId, transactionType: type, isFinanciallySuccessful: true },
      orderBy: { occurredAt: 'desc' },
    });
    if (!last) return;
    // deposit_count drives the lifecycle stage (Lead → FTD → Repeat → Regular). It's
    // only seeded from the CSV import, so a lead who deposits via the live webhook
    // keeps count 0 and stays "Lead" forever unless we bump it here. Forward-only via
    // greatest(): raise an under-count from the ledger, never lower the imported total.
    const ledgerCount = await this.prisma.transaction.count({
      where: { tenantId, customerId, transactionType: type, isFinanciallySuccessful: true },
    });
    const c = await this.prisma.customer.findUnique({
      where: { id: customerId },
      select: { lastDepositAt: true, lastWithdrawalAt: true, depositCount: true, withdrawalCount: true },
    });
    if (type === 'DEPOSIT') {
      const data: Prisma.CustomerUpdateInput = {};
      if (!c?.lastDepositAt || c.lastDepositAt < last.occurredAt) { data.lastDepositAt = last.occurredAt; data.lastDepositAmount = last.amount; }
      if (ledgerCount > (c?.depositCount ?? 0)) data.depositCount = ledgerCount;
      if (Object.keys(data).length) await this.prisma.customer.update({ where: { id: customerId }, data });
    } else {
      const data: Prisma.CustomerUpdateInput = {};
      if (!c?.lastWithdrawalAt || c.lastWithdrawalAt < last.occurredAt) { data.lastWithdrawalAt = last.occurredAt; data.lastWithdrawalAmount = last.amount; }
      if (ledgerCount > (c?.withdrawalCount ?? 0)) data.withdrawalCount = ledgerCount;
      if (Object.keys(data).length) await this.prisma.customer.update({ where: { id: customerId }, data });
    }
  }

  async recomputeFtd(tenantId: string, customerId: string): Promise<void> {
    const first = await this.prisma.transaction.findFirst({
      where: { tenantId, customerId, transactionType: 'DEPOSIT', isFinanciallySuccessful: true },
      orderBy: { occurredAt: 'asc' },
    });
    await this.prisma.customer.update({
      where: { id: customerId },
      data: {
        ftdDate: first?.occurredAt ?? null,
        ftdAmount: first?.amount ?? null,
        ftdTransactionId: first?.id ?? null,
      },
    });
  }

  /** KPI summary + recent rows for a tenant, within [from, to) by occurredAt.
   * Powers the Transactions page — replaces the old BetIndia-only Supabase read
   * so each company sees ITS OWN transactions. `from` null = all time. */
  async summary(tenantId: string, fromMs: number | null, toMs: number, masterId?: string) {
    const where: Prisma.TransactionWhereInput = {
      ...transactionScope(tenantId, masterId),
      occurredAt: { ...(fromMs != null ? { gte: new Date(fromMs) } : {}), lt: new Date(toMs) },
    };

    const grouped = await this.prisma.transaction.groupBy({
      by: ['transactionType', 'normalizedStatus'],
      where,
      _sum: { amount: true },
      _count: true,
    });
    // Roll the (type × status) groups up into the numbers the KPI cards show.
    // REJECTED and FAILED are both treated as "rejected" for display.
    const roll = (type: TransactionType, statuses: string[], field: 'amount' | 'count') =>
      grouped
        .filter((g) => g.transactionType === type && statuses.includes(String(g.normalizedStatus)))
        .reduce((n, g) => n + (field === 'amount' ? Number(g._sum.amount ?? 0) : g._count), 0);
    const ALL = ['APPROVED', 'PENDING', 'REJECTED', 'FAILED'];

    const summary = {
      depositCount: roll('DEPOSIT', ALL, 'count'),
      depositTotalAmount: roll('DEPOSIT', ALL, 'amount'),
      depositApprovedCount: roll('DEPOSIT', ['APPROVED'], 'count'),
      depositApprovedAmount: roll('DEPOSIT', ['APPROVED'], 'amount'),
      depositRejectedCount: roll('DEPOSIT', ['REJECTED', 'FAILED'], 'count'),
      depositRejectedAmount: roll('DEPOSIT', ['REJECTED', 'FAILED'], 'amount'),
      depositPendingCount: roll('DEPOSIT', ['PENDING'], 'count'),
      depositPendingAmount: roll('DEPOSIT', ['PENDING'], 'amount'),
      withdrawalCount: roll('WITHDRAWAL', ALL, 'count'),
      withdrawalApprovedAmount: roll('WITHDRAWAL', ['APPROVED'], 'amount'),
      withdrawalPendingAmount: roll('WITHDRAWAL', ['PENDING', 'FAILED'], 'amount'),
    };

    const rows = await this.prisma.transaction.findMany({
      where,
      orderBy: { occurredAt: 'desc' },
      take: 500,
      include: { customer: { select: { name: true, phone: true, externalUserId: true } } },
    });
    const display = (s: string) => (s === 'APPROVED' ? 'approved' : s === 'PENDING' ? 'pending' : 'rejected');
    const recent = rows.map((r) => ({
      id: r.id,
      type: r.transactionType === 'DEPOSIT' ? 'deposit' : 'withdrawal',
      transaction_id: r.externalTransactionId,
      user_name: r.customer?.name ?? null,
      user_id: r.customer?.externalUserId ?? null,
      mobile_number: r.customer?.phone ?? null,
      amount: Number(r.amount),
      display_status: display(String(r.normalizedStatus)),
      status_label: String(r.normalizedStatus).toLowerCase(),
      created_at: r.occurredAt.toISOString(),
    }));

    return { summary, recent };
  }

  async list(tenantId: string, opts: { type?: string; status?: string; search?: string; page?: number; pageSize?: number; masterId?: string }) {
    const page = Math.max(1, opts.page ?? 1);
    const pageSize = Math.min(500, Math.max(1, opts.pageSize ?? 50));
    const type = normalizeType(opts.type);
    const where: Prisma.TransactionWhereInput = {
      ...transactionScope(tenantId, opts.masterId),
      ...(type ? { transactionType: type as TransactionType } : {}),
      ...(opts.status ? { normalizedStatus: opts.status.toUpperCase() as never } : {}),
      ...(opts.search
        ? { externalTransactionId: { contains: opts.search.trim(), mode: 'insensitive' } }
        : {}),
    };
    const [data, total] = await Promise.all([
      this.prisma.transaction.findMany({ where, orderBy: { occurredAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize }),
      this.prisma.transaction.count({ where }),
    ]);
    return { data, page, pageSize, total };
  }
}
