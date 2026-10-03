import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { computeRanges, growth, type PeriodKey, type Range } from './periods';
import { customerScope } from '../customers/master-scope';

type TxnAgg = { dep_sum: number; dep_cnt: number; wd_sum: number; wd_cnt: number; active: number };
type CustAgg = { new_cust: number; ftd: number };

type UserRowRaw = {
  userId: string | null; branchId: string | null; name: string | null; mobile: string | null;
  registerDate: Date | null; firstDepositAt: Date | null; firstDepositAmount: number | null;
  depositCount: number; depositTotal: number; withdrawalCount: number; withdrawalTotal: number;
  pnl: number; lastActivityAt: Date | null; reportStatus: string | null;
};

/** Shape one saas.customers/breakdown row into the UserRow the analytics page expects. */
function toUserRow(r: UserRowRaw, now: number) {
  const last = r.lastActivityAt ? new Date(r.lastActivityAt).getTime() : null;
  const ageDays = last == null ? null : (now - last) / 86_400_000;
  const status = ageDays == null ? 'registered_only' : ageDays <= 7 ? 'active' : ageDays <= 30 ? 'lapsed' : 'dormant';
  return {
    userId: r.userId ?? '', branchId: r.branchId, name: r.name && r.name !== '0' ? r.name : null, mobile: r.mobile,
    registerDate: r.registerDate, registered: true,
    firstDepositAt: r.firstDepositAt, firstDepositAmount: r.firstDepositAmount == null ? null : Number(r.firstDepositAmount),
    depositCount: Number(r.depositCount), depositTotal: Number(r.depositTotal),
    withdrawalCount: Number(r.withdrawalCount), withdrawalTotal: Number(r.withdrawalTotal),
    pnl: Number(r.pnl), lastActivityAt: r.lastActivityAt, lastRemark: null,
    depositor: Number(r.depositCount) > 0, status, fromReport: r.firstDepositAt != null, reportStatus: r.reportStatus,
  };
}

@Injectable()
export class DashboardService {
  constructor(private readonly prisma: PrismaService) {}

  private async tenantTz(tenantId: string): Promise<string> {
    const t = await this.prisma.tenant.findUnique({ where: { id: tenantId }, select: { timezone: true } });
    return t?.timezone || 'Asia/Kolkata';
  }

  /** Successful deposit/withdrawal sums + active customers in a date window. */
  private async txnAgg(tenantId: string, r: Range, masterId?: string): Promise<TxnAgg> {
    const rows = await this.prisma.$queryRawUnsafe<TxnAgg[]>(
      `select
         coalesce(sum(amount) filter (where transaction_type='DEPOSIT'), 0)::float8 as dep_sum,
         count(*) filter (where transaction_type='DEPOSIT')::int as dep_cnt,
         coalesce(sum(amount) filter (where transaction_type='WITHDRAWAL'), 0)::float8 as wd_sum,
         count(*) filter (where transaction_type='WITHDRAWAL')::int as wd_cnt,
         count(distinct customer_id)::int as active
       from saas.transactions t
       where t.tenant_id = $1 and is_financially_successful
         and occurred_at >= $2 and occurred_at < $3
         and ($4::text is null or exists (
           select 1 from saas.customers c where c.id = t.customer_id
           and c.tenant_id = $1 and c.master_id = $4))`,
      tenantId, r.start, r.end, masterId ?? null,
    );
    return rows[0];
  }

  /** New registrations + first-time depositors in a date window. */
  private async custAgg(tenantId: string, r: Range, masterId?: string): Promise<CustAgg> {
    const rows = await this.prisma.$queryRawUnsafe<CustAgg[]>(
      `select
         count(*) filter (where registration_at >= $2 and registration_at < $3)::int as new_cust,
         count(*) filter (where ftd_date >= $2 and ftd_date < $3)::int as ftd
       from saas.customers where tenant_id = $1
         and ($4::text is null or master_id = $4)`,
      tenantId, r.start, r.end, masterId ?? null,
    );
    return rows[0];
  }

  /** Player-analytics page data, built from the LIVE saas tables (replaces the old
   * Supabase public.* read that froze). Lifetime figures come straight from
   * saas.customers; active/today counts from saas.transactions. */
  async userAnalytics(tenantId: string, masterId?: string) {
    const tz = await this.tenantTz(tenantId);
    const now = Date.now();

    // Customer-side rollup. At scale this full-table aggregate is the slow part, so we
    // can read it from the saas.mv_tenant_metrics materialized view instead. The MV is
    // used ONLY when USE_METRICS_MV=1 AND there's no master filter (the MV is per-tenant,
    // not per-master). We fall back to a live aggregate for: the flag being off, any
    // master-scoped request, a tenant not yet in the MV, or any MV read error — so the
    // numbers are always correct, just possibly a few minutes stale when served from the MV.
    type CustAggRow = {
      registered_users: number; depositors: number; never_deposited: number;
      deposit_total: number; withdrawal_total: number; avg_first_deposit: number;
      new7: number; new30: number; dormant_depositors: number;
    };
    const liveCustAgg = () => this.prisma.$queryRawUnsafe<CustAggRow[]>(
      `select
         count(*)::int as registered_users,
         count(*) filter (where coalesce(deposit_count,0) > 0)::int as depositors,
         count(*) filter (where coalesce(deposit_count,0) = 0)::int as never_deposited,
         coalesce(sum(total_deposits),0)::float8 as deposit_total,
         coalesce(sum(total_withdrawals),0)::float8 as withdrawal_total,
         coalesce(avg(ftd_amount) filter (where ftd_amount is not null),0)::float8 as avg_first_deposit,
         count(*) filter (where registration_at >= now() - interval '7 days')::int as new7,
         count(*) filter (where registration_at >= now() - interval '30 days')::int as new30,
         count(*) filter (where coalesce(deposit_count,0) > 0
           and coalesce(greatest(last_deposit_at, last_withdrawal_at), to_timestamp(0)) < now() - interval '30 days')::int as dormant_depositors
       from saas.customers
       where tenant_id = $1 and ($2::text is null or master_id = $2)`,
      tenantId, masterId ?? null,
    );

    let cust: CustAggRow | undefined;
    if (process.env.USE_METRICS_MV === '1' && !masterId) {
      const rows = await this.prisma.$queryRawUnsafe<CustAggRow[]>(
        `select registered_users, depositors, never_deposited, deposit_total, withdrawal_total,
                avg_first_deposit, new7, new30, dormant_depositors
         from saas.mv_tenant_metrics where tenant_id = $1`,
        tenantId,
      ).catch(() => [] as CustAggRow[]); // MV absent / mid-refresh error → fall through to live
      cust = rows[0];
    }
    if (!cust) [cust] = await liveCustAgg();

    const [txn] = await this.prisma.$queryRawUnsafe<Array<{
      active_today: number; active7: number; active30: number; today_deposit: number; today_withdrawal: number;
    }>>(
      `with day0 as (select (date_trunc('day', now() at time zone $2) at time zone $2) as d)
       select
         count(distinct customer_id) filter (where occurred_at >= (select d from day0))::int as active_today,
         count(distinct customer_id) filter (where occurred_at >= now() - interval '7 days')::int as active7,
         count(distinct customer_id) filter (where occurred_at >= now() - interval '30 days')::int as active30,
         coalesce(sum(amount) filter (where occurred_at >= (select d from day0) and transaction_type='DEPOSIT' and is_financially_successful),0)::float8 as today_deposit,
         coalesce(sum(amount) filter (where occurred_at >= (select d from day0) and transaction_type='WITHDRAWAL' and is_financially_successful),0)::float8 as today_withdrawal
       from saas.transactions t
       where t.tenant_id = $1
         and ($3::text is null or exists (select 1 from saas.customers c where c.id = t.customer_id and c.tenant_id = $1 and c.master_id = $3))`,
      tenantId, tz, masterId ?? null,
    );

    const rows = await this.prisma.$queryRawUnsafe<Array<UserRowRaw>>(
      `select
         external_user_id as "userId", master_id as "branchId", name, phone as mobile,
         registration_at as "registerDate", ftd_date as "firstDepositAt", ftd_amount::float8 as "firstDepositAmount",
         coalesce(deposit_count,0)::int as "depositCount", coalesce(total_deposits,0)::float8 as "depositTotal",
         coalesce(withdrawal_count,0)::int as "withdrawalCount", coalesce(total_withdrawals,0)::float8 as "withdrawalTotal",
         (coalesce(total_deposits,0)-coalesce(total_withdrawals,0))::float8 as pnl,
         greatest(last_deposit_at, last_withdrawal_at) as "lastActivityAt", current_lifecycle as "reportStatus"
       from saas.customers
       where tenant_id = $1 and ($2::text is null or master_id = $2)
       order by total_deposits desc nulls last
       limit 5000`,
      tenantId, masterId ?? null,
    );

    const registeredUsers = Number(cust.registered_users);
    const depositors = Number(cust.depositors);
    return {
      configured: true,
      generatedAt: new Date(now).toISOString(),
      totals: {
        registeredUsers,
        depositors,
        ftdConversionPct: registeredUsers ? Math.round((depositors / registeredUsers) * 1000) / 10 : 0,
        activeUsersToday: Number(txn.active_today),
        activeUsers7d: Number(txn.active7),
        activeUsers30d: Number(txn.active30),
        dormantDepositors: Number(cust.dormant_depositors),
        neverDeposited: Number(cust.never_deposited),
        newRegistrations7d: Number(cust.new7),
        newRegistrations30d: Number(cust.new30),
        depositTotal: Number(cust.deposit_total),
        withdrawalTotal: Number(cust.withdrawal_total),
        netPnl: Number(cust.deposit_total) - Number(cust.withdrawal_total),
        avgFirstDeposit: Math.round(Number(cust.avg_first_deposit)),
        todayDepositTotal: Number(txn.today_deposit),
        todayWithdrawalTotal: Number(txn.today_withdrawal),
      },
      users: rows.map((r) => toUserRow(r, now)),
    };
  }

  /** Per-user breakdown scoped to a date window (deposits/withdrawals computed only
   * from transactions in [from, to)). Powers the page's date-range view. */
  async userBreakdown(tenantId: string, fromIso: string, toIso: string, masterId?: string) {
    const now = Date.now();
    const rows = await this.prisma.$queryRawUnsafe<Array<UserRowRaw>>(
      `select
         c.external_user_id as "userId", c.master_id as "branchId", c.name, c.phone as mobile,
         c.registration_at as "registerDate",
         min(t.occurred_at) filter (where t.transaction_type='DEPOSIT' and t.is_financially_successful) as "firstDepositAt",
         null::float8 as "firstDepositAmount",
         count(*) filter (where t.transaction_type='DEPOSIT' and t.is_financially_successful)::int as "depositCount",
         coalesce(sum(t.amount) filter (where t.transaction_type='DEPOSIT' and t.is_financially_successful),0)::float8 as "depositTotal",
         count(*) filter (where t.transaction_type='WITHDRAWAL' and t.is_financially_successful)::int as "withdrawalCount",
         coalesce(sum(t.amount) filter (where t.transaction_type='WITHDRAWAL' and t.is_financially_successful),0)::float8 as "withdrawalTotal",
         (coalesce(sum(t.amount) filter (where t.transaction_type='DEPOSIT' and t.is_financially_successful),0)
          - coalesce(sum(t.amount) filter (where t.transaction_type='WITHDRAWAL' and t.is_financially_successful),0))::float8 as pnl,
         max(t.occurred_at) as "lastActivityAt", null::text as "reportStatus"
       from saas.transactions t
       join saas.customers c on c.id = t.customer_id and c.tenant_id = t.tenant_id
       where t.tenant_id = $1 and t.occurred_at >= $2 and t.occurred_at < $3
         and ($4::text is null or c.master_id = $4)
       group by c.id, c.external_user_id, c.master_id, c.name, c.phone, c.registration_at
       order by "depositTotal" desc
       limit 5000`,
      tenantId, new Date(fromIso), new Date(toIso), masterId ?? null,
    );
    return { rows: rows.map((r) => toUserRow(r, now)) };
  }

  async overview(tenantId: string, period: PeriodKey, customFrom?: string, customTo?: string, masterId?: string) {
    const tz = await this.tenantTz(tenantId);
    const ranges = computeRanges(tz, period, new Date(), customFrom, customTo);

    const [curTxn, prevTxn, curCust, prevCust, totalCustomers] = await Promise.all([
      this.txnAgg(tenantId, ranges.current, masterId),
      this.txnAgg(tenantId, ranges.previous, masterId),
      this.custAgg(tenantId, ranges.current, masterId),
      this.custAgg(tenantId, ranges.previous, masterId),
      this.prisma.customer.count({ where: customerScope(tenantId, masterId) }),
    ]);

    const curPl = curTxn.dep_sum - curTxn.wd_sum;
    const prevPl = prevTxn.dep_sum - prevTxn.wd_sum;

    return {
      masterId: masterId ?? null,
      period,
      label: ranges.label,
      range: ranges,
      totalCustomers,
      kpis: {
        newCustomers: growth(curCust.new_cust, prevCust.new_cust),
        ftd: growth(curCust.ftd, prevCust.ftd),
        activeCustomers: growth(curTxn.active, prevTxn.active),
        deposits: growth(curTxn.dep_sum, prevTxn.dep_sum),
        withdrawals: growth(curTxn.wd_sum, prevTxn.wd_sum),
        companyPl: growth(curPl, prevPl),
      },
      counts: {
        depositCount: curTxn.dep_cnt,
        withdrawalCount: curTxn.wd_cnt,
      },
    };
  }

  /** The underlying records behind one overview KPI, for the current period.
   * Powers "click a card to see the details". */
  async details(
    tenantId: string,
    period: PeriodKey,
    metric: string,
    customFrom?: string,
    customTo?: string,
    masterId?: string,
  ): Promise<{ metric: string; kind: 'transactions' | 'customers'; label: string; rows: unknown[] }> {
    const tz = await this.tenantTz(tenantId);
    const { current: r, label } = computeRanges(tz, period, new Date(), customFrom, customTo);
    const LIMIT = 500;

    if (metric === 'deposits' || metric === 'withdrawals' || metric === 'transactions') {
      const typeFilter =
        metric === 'deposits' ? `and t.transaction_type='DEPOSIT'`
        : metric === 'withdrawals' ? `and t.transaction_type='WITHDRAWAL'`
        : '';
      const rows = await this.prisma.$queryRawUnsafe(
        `select t.external_transaction_id as txn_id, lower(t.transaction_type::text) as type,
                c.name, c.external_user_id as user_id, c.phone,
                t.amount::float8 as amount, t.occurred_at, t.normalized_status::text as status
           from saas.transactions t join saas.customers c on c.id = t.customer_id and c.tenant_id = t.tenant_id
          where t.tenant_id = $1 and t.is_financially_successful
            and t.occurred_at >= $2 and t.occurred_at < $3 ${typeFilter}
            and ($4::text is null or c.master_id = $4)
          order by t.occurred_at desc limit ${LIMIT}`,
        tenantId, r.start, r.end, masterId ?? null,
      );
      return { metric, kind: 'transactions', label, rows: rows as unknown[] };
    }

    if (metric === 'new') {
      const rows = await this.prisma.$queryRawUnsafe(
        `select external_user_id as user_id, name, phone, registration_at as occurred_at,
                current_lifecycle as status
           from saas.customers
          where tenant_id = $1 and registration_at >= $2 and registration_at < $3
            and ($4::text is null or master_id = $4)
          order by registration_at desc limit ${LIMIT}`,
        tenantId, r.start, r.end, masterId ?? null,
      );
      return { metric, kind: 'customers', label, rows: rows as unknown[] };
    }

    if (metric === 'ftd') {
      const rows = await this.prisma.$queryRawUnsafe(
        `select external_user_id as user_id, name, phone, ftd_date as occurred_at,
                ftd_amount::float8 as amount
           from saas.customers
          where tenant_id = $1 and ftd_date >= $2 and ftd_date < $3
            and ($4::text is null or master_id = $4)
          order by ftd_date desc limit ${LIMIT}`,
        tenantId, r.start, r.end, masterId ?? null,
      );
      return { metric, kind: 'customers', label, rows: rows as unknown[] };
    }

    if (metric === 'active') {
      const rows = await this.prisma.$queryRawUnsafe(
        `select c.external_user_id as user_id, c.name, c.phone,
                count(*)::int as txns, coalesce(sum(t.amount), 0)::float8 as amount,
                max(t.occurred_at) as occurred_at
           from saas.transactions t join saas.customers c on c.id = t.customer_id and c.tenant_id = t.tenant_id
          where t.tenant_id = $1 and t.is_financially_successful
            and t.occurred_at >= $2 and t.occurred_at < $3
            and ($4::text is null or c.master_id = $4)
          group by c.id, c.external_user_id, c.name, c.phone
          order by amount desc limit ${LIMIT}`,
        tenantId, r.start, r.end, masterId ?? null,
      );
      return { metric, kind: 'customers', label, rows: rows as unknown[] };
    }

    throw new Error('Unknown metric');
  }
}
