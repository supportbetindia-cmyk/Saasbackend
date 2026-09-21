import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { computeRanges, growth, type PeriodKey, type Range } from './periods';

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
  private async txnAgg(tenantId: string, r: Range): Promise<TxnAgg> {
    const rows = await this.prisma.$queryRawUnsafe<TxnAgg[]>(
      `select
         coalesce(sum(amount) filter (where transaction_type='DEPOSIT'), 0)::float8 as dep_sum,
         count(*) filter (where transaction_type='DEPOSIT')::int as dep_cnt,
         coalesce(sum(amount) filter (where transaction_type='WITHDRAWAL'), 0)::float8 as wd_sum,
         count(*) filter (where transaction_type='WITHDRAWAL')::int as wd_cnt,
         count(distinct customer_id)::int as active
       from saas.transactions
       where tenant_id = $1 and is_financially_successful
         and occurred_at >= $2 and occurred_at < $3`,
      tenantId, r.start, r.end,
    );
    return rows[0];
  }

  /** New registrations + first-time depositors in a date window. */
  private async custAgg(tenantId: string, r: Range): Promise<CustAgg> {
    const rows = await this.prisma.$queryRawUnsafe<CustAgg[]>(
      `select
         count(*) filter (where registration_at >= $2 and registration_at < $3)::int as new_cust,
         count(*) filter (where ftd_date >= $2 and ftd_date < $3)::int as ftd
       from saas.customers where tenant_id = $1`,
      tenantId, r.start, r.end,
    );
    return rows[0];
  }

  async overview(tenantId: string, period: PeriodKey, customFrom?: string, customTo?: string) {
    const tz = await this.tenantTz(tenantId);
    const ranges = computeRanges(tz, period, new Date(), customFrom, customTo);

    const [curTxn, prevTxn, curCust, prevCust, totalCustomers] = await Promise.all([
      this.txnAgg(tenantId, ranges.current),
      this.txnAgg(tenantId, ranges.previous),
      this.custAgg(tenantId, ranges.current),
      this.custAgg(tenantId, ranges.previous),
      this.prisma.customer.count({ where: { tenantId } }),
    ]);

    const curPl = curTxn.dep_sum - curTxn.wd_sum;
    const prevPl = prevTxn.dep_sum - prevTxn.wd_sum;

    return {
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
}
