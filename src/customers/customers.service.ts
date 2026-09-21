import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { normalizePhone } from '../transactions/status';

/** UTC instant of "today" midnight in the given IANA timezone (no DST inside a day for IST). */
function startOfTodayUtc(tz: string): Date {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(now);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? '0');
  const msSinceLocalMidnight = ((get('hour') % 24) * 3600 + get('minute') * 60 + get('second')) * 1000 + now.getMilliseconds();
  return new Date(now.getTime() - msSinceLocalMidnight);
}

export type UpsertCustomerInput = {
  externalUserId?: string | null;
  masterId?: string | null;
  name?: string | null;
  phone?: string | null;
  email?: string | null;
  registrationAt?: string | Date | null;
};

@Injectable()
export class CustomersService {
  constructor(private readonly prisma: PrismaService) {}

  /** Find-or-create a customer by external User ID within a tenant. */
  async upsertByExternal(tenantId: string, input: UpsertCustomerInput) {
    const phoneNormalized = normalizePhone(input.phone);
    const reg = input.registrationAt ? new Date(input.registrationAt) : undefined;
    if (input.externalUserId) {
      return this.prisma.customer.upsert({
        where: { tenantId_externalUserId: { tenantId, externalUserId: input.externalUserId } },
        update: {
          masterId: input.masterId ?? undefined,
          name: input.name ?? undefined,
          phone: input.phone ?? undefined,
          phoneNormalized: phoneNormalized ?? undefined,
          email: input.email ?? undefined,
          registrationAt: reg,
        },
        create: {
          tenantId,
          externalUserId: input.externalUserId,
          masterId: input.masterId ?? null,
          name: input.name ?? null,
          phone: input.phone ?? null,
          phoneNormalized,
          email: input.email ?? null,
          registrationAt: reg ?? null,
        },
      });
    }
    return this.prisma.customer.create({
      data: {
        tenantId,
        name: input.name ?? null,
        phone: input.phone ?? null,
        phoneNormalized,
        email: input.email ?? null,
        registrationAt: reg ?? null,
      },
    });
  }

  async list(
    tenantId: string,
    opts: { search?: string; page?: number; pageSize?: number; missingRegistration?: boolean },
  ) {
    const page = Math.max(1, opts.page ?? 1);
    const pageSize = Math.min(200, Math.max(1, opts.pageSize ?? 50));
    const q = (opts.search ?? '').trim();
    const where = {
      tenantId,
      ...(opts.missingRegistration ? { registrationAt: null } : {}),
      ...(q
        ? {
            OR: [
              { externalUserId: { contains: q, mode: 'insensitive' as const } },
              { masterId: { contains: q, mode: 'insensitive' as const } },
              { name: { contains: q, mode: 'insensitive' as const } },
              { phoneNormalized: { contains: q.replace(/\D/g, '') } },
              { email: { contains: q, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    };
    const [data, total] = await Promise.all([
      this.prisma.customer.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize }),
      this.prisma.customer.count({ where }),
    ]);
    // Attach today's confirmed deposit/withdrawal totals for this page of players.
    const today = await this.todayTotals(tenantId, data.map((c) => c.id));
    const enriched = data.map((c) => ({
      ...c,
      todayDeposits: today.get(c.id)?.dep ?? 0,
      todayWithdrawals: today.get(c.id)?.wd ?? 0,
    }));
    return { data: enriched, page, pageSize, total };
  }

  /** Tenant timezone (falls back to Asia/Kolkata). */
  private async tenantTz(tenantId: string): Promise<string> {
    const t = await this.prisma.tenant.findUnique({ where: { id: tenantId }, select: { timezone: true } });
    return t?.timezone || 'Asia/Kolkata';
  }

  /** Today's confirmed deposit/withdrawal amount per customer id (tenant timezone). */
  private async todayTotals(tenantId: string, ids: string[]): Promise<Map<string, { dep: number; wd: number }>> {
    const map = new Map<string, { dep: number; wd: number }>();
    if (ids.length === 0) return map;
    const start = startOfTodayUtc(await this.tenantTz(tenantId));
    const end = new Date(start.getTime() + 86_400_000);
    const grouped = await this.prisma.transaction.groupBy({
      by: ['customerId', 'transactionType'],
      where: { tenantId, customerId: { in: ids }, isFinanciallySuccessful: true, occurredAt: { gte: start, lt: end } },
      _sum: { amount: true },
    });
    for (const g of grouped) {
      const e = map.get(g.customerId) ?? { dep: 0, wd: 0 };
      if (g.transactionType === 'DEPOSIT') e.dep = Number(g._sum.amount ?? 0);
      else e.wd = Number(g._sum.amount ?? 0);
      map.set(g.customerId, e);
    }
    return map;
  }

  /** Customer 360: identity + financial aggregates derived from transactions. */
  async get360(tenantId: string, customerId: string) {
    const customer = await this.prisma.customer.findFirst({ where: { id: customerId, tenantId } });
    if (!customer) throw new NotFoundException('Customer not found');

    // Lifecycle / value-tier change history (newest first) for this customer.
    const classificationHistory = await this.prisma.classificationEvent.findMany({
      where: { tenantId, customerId },
      orderBy: { changedAt: 'desc' },
      take: 20,
    });

    const base = { tenantId, customerId, isFinanciallySuccessful: true } as const;
    const [dep, wd] = await Promise.all([
      this.prisma.transaction.aggregate({
        where: { ...base, transactionType: 'DEPOSIT' },
        _sum: { amount: true }, _count: true, _min: { occurredAt: true }, _max: { occurredAt: true },
      }),
      this.prisma.transaction.aggregate({
        where: { ...base, transactionType: 'WITHDRAWAL' },
        _sum: { amount: true }, _count: true, _min: { occurredAt: true }, _max: { occurredAt: true },
      }),
    ]);

    const totalDeposits = Number(dep._sum.amount ?? 0);
    const depositCount = dep._count;
    const totalWithdrawals = Number(wd._sum.amount ?? 0);
    const withdrawalCount = wd._count;
    const lastDeposit = dep._max.occurredAt;
    const daysSinceLastDeposit = lastDeposit ? Math.floor((Date.now() - lastDeposit.getTime()) / 86_400_000) : null;

    const todayMap = await this.todayTotals(tenantId, [customerId]);
    const today = todayMap.get(customerId) ?? { dep: 0, wd: 0 };

    const num = (v: unknown) => (v == null ? null : Number(v));
    // Lifetime totals from the source report (public.users / CSV). These are the
    // authoritative deposit/withdrawal figures; the ledger below is only recent activity.
    const lifetime = {
      totalDeposits: num(customer.totalDeposits),
      depositCount: customer.depositCount,
      totalWithdrawals: num(customer.totalWithdrawals),
      withdrawalCount: customer.withdrawalCount,
      netPnl: num(customer.netPnl),
      totalBonus: num(customer.totalBonus),
      lastDepositAt: customer.lastDepositAt,
      lastDepositAmount: num(customer.lastDepositAmount),
      lastWithdrawalAt: customer.lastWithdrawalAt,
      lastWithdrawalAmount: num(customer.lastWithdrawalAmount),
    };

    return {
      customer,
      lifetime,
      // Recent/webhook ledger activity — only counts financially successful transactions.
      ledger: {
        totalDeposits,
        depositCount,
        averageDeposit: depositCount ? Math.round((totalDeposits / depositCount) * 100) / 100 : null,
        firstDeposit: dep._min.occurredAt,
        lastDeposit,
        totalWithdrawals,
        withdrawalCount,
        firstWithdrawal: wd._min.occurredAt,
        lastWithdrawal: wd._max.occurredAt,
        pl: totalDeposits - totalWithdrawals,
        daysSinceLastDeposit,
      },
      ftd: { date: customer.ftdDate, amount: num(customer.ftdAmount), transactionId: customer.ftdTransactionId },
      today: { deposits: today.dep, withdrawals: today.wd },
      classificationHistory,
    };
  }

  async transactionsFor(tenantId: string, customerId: string, opts: { page?: number; pageSize?: number }) {
    const exists = await this.prisma.customer.findFirst({ where: { id: customerId, tenantId }, select: { id: true } });
    if (!exists) throw new NotFoundException('Customer not found');
    const page = Math.max(1, opts.page ?? 1);
    const pageSize = Math.min(500, Math.max(1, opts.pageSize ?? 100));
    const where = { tenantId, customerId };
    const [data, total] = await Promise.all([
      this.prisma.transaction.findMany({ where, orderBy: { occurredAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize }),
      this.prisma.transaction.count({ where }),
    ]);
    return { data, page, pageSize, total };
  }
}
