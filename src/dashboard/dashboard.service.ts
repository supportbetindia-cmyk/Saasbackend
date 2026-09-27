import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { computeRanges, growth, type PeriodKey, type Range } from './periods';
import { customerScope } from '../customers/master-scope';

type TxnAgg = { dep_sum: number; dep_cnt: number; wd_sum: number; wd_cnt: number; active: number };
type CustAgg = { new_cust: number; ftd: number };

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
