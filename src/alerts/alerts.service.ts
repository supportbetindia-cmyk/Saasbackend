import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

// V1 thresholds. Trusted code constants (interpolated into SQL) — not user input.
const VIP_INACTIVE_DAYS = 7;     // a VIP with no activity this long → alert
const BIG_WITHDRAWAL_MIN = 50000; // withdrawal ≥ this (INR) → alert
const FTD_DROP_RATIO = 0.5;       // today's FTDs below this fraction of the daily avg → alert
const FTD_MIN_BASELINE = 3;       // only alert on FTD drop when the avg is at least this

type AlertRow = {
  id: string; type: string; severity: string; title: string; body: string | null;
  entity_id: string | null; value: string | null; acknowledged: boolean; created_at: Date;
};

@Injectable()
export class AlertsService {
  private readonly log = new Logger('Alerts');
  constructor(private readonly prisma: PrismaService) {}

  /** Run every detection rule for a tenant. Inserts are deduped by alert_key
   * (unique), so re-running never creates duplicates. Returns how many were new. */
  async runTenant(tenantId: string): Promise<{ created: number }> {
    const counts = await Promise.all([
      this.detectVipInactive(tenantId),
      this.detectBigWithdrawals(tenantId),
      this.detectFtdDrop(tenantId),
    ]);
    const created = counts.reduce((a, b) => a + b, 0);
    if (created) this.log.log(`${tenantId}: ${created} new alert(s)`);
    return { created };
  }

  // One alert per VIP per ISO week (IYYY-IW) → re-alerts weekly while still quiet, not daily.
  private detectVipInactive(tenantId: string): Promise<number> {
    return this.prisma.$executeRawUnsafe(
      `insert into saas.alerts (alert_key, tenant_id, type, severity, title, body, entity_id, value)
       select 'vip_inactive|' || c.id::text || '|' || to_char(now(),'IYYY-IW'),
              c.tenant_id, 'vip_inactive', 'high', 'VIP went quiet',
              coalesce(nullif(c.name,''),'A VIP') || ' — ₹' || round(coalesce(c.total_deposits,0))::text
                || ' lifetime, no activity in ${VIP_INACTIVE_DAYS}+ days',
              c.id::text, coalesce(c.total_deposits,0)
       from saas.customers c
       where c.tenant_id = $1 and c.current_category = 'VIP'
         and coalesce(greatest(c.last_deposit_at, c.last_withdrawal_at), to_timestamp(0))
             < now() - interval '${VIP_INACTIVE_DAYS} days'
       on conflict (alert_key) do nothing`,
      tenantId,
    );
  }

  // One alert per withdrawal transaction (deduped by its id).
  private detectBigWithdrawals(tenantId: string): Promise<number> {
    return this.prisma.$executeRawUnsafe(
      `insert into saas.alerts (alert_key, tenant_id, type, severity, title, body, entity_id, value)
       select 'big_withdrawal|' || t.id::text,
              t.tenant_id, 'big_withdrawal', 'medium', 'Large withdrawal',
              coalesce(nullif(c.name,''),'A player') || ' withdrew ₹' || round(t.amount)::text,
              c.id::text, t.amount
       from saas.transactions t
       join saas.customers c on c.id = t.customer_id and c.tenant_id = t.tenant_id
       where t.tenant_id = $1 and t.transaction_type = 'WITHDRAWAL' and t.is_financially_successful
         and t.amount >= ${BIG_WITHDRAWAL_MIN}
         and t.occurred_at >= now() - interval '1 day'
       on conflict (alert_key) do nothing`,
      tenantId,
    );
  }

  // One alert per tenant per day, only when there's a real baseline and today is well below it.
  private detectFtdDrop(tenantId: string): Promise<number> {
    return this.prisma.$executeRawUnsafe(
      `with ftd_today as (
         select count(*)::int c from saas.customers where tenant_id = $1 and ftd_date::date = current_date
       ), ftd_avg as (
         select coalesce(avg(cnt),0) a from (
           select count(*) cnt from saas.customers
           where tenant_id = $1 and ftd_date::date >= current_date - 7 and ftd_date::date < current_date
           group by ftd_date::date
         ) x
       )
       insert into saas.alerts (alert_key, tenant_id, type, severity, title, body, value)
       select 'ftd_drop|' || $1 || '|' || to_char(current_date,'YYYY-MM-DD'),
              $1, 'ftd_drop', 'medium', 'First deposits down today',
              'Only ' || ft.c::text || ' first deposits today vs ~' || round(fa.a)::text || ' daily average',
              ft.c
       from ftd_today ft, ftd_avg fa
       where fa.a >= ${FTD_MIN_BASELINE} and ft.c < fa.a * ${FTD_DROP_RATIO}
       on conflict (alert_key) do nothing`,
      tenantId,
    );
  }

  async list(tenantId: string, onlyUnacked = false): Promise<AlertRow[]> {
    return this.prisma.$queryRawUnsafe<AlertRow[]>(
      `select id::text, type, severity, title, body, entity_id, value::text, acknowledged, created_at
       from saas.alerts
       where tenant_id = $1 ${onlyUnacked ? 'and acknowledged = false' : ''}
       order by acknowledged asc, created_at desc
       limit 100`,
      tenantId,
    );
  }

  async ack(tenantId: string, id: string): Promise<{ ok: true }> {
    const n = await this.prisma.$executeRawUnsafe(
      `update saas.alerts set acknowledged = true where tenant_id = $1 and id = $2::bigint`,
      tenantId, id,
    );
    if (n === 0) throw new BadRequestException('Alert not found');
    return { ok: true };
  }
}
