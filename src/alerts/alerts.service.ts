import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

// V1 thresholds. Trusted code constants (interpolated into SQL) — not user input.
const VIP_INACTIVE_DAYS = 7;     // a VIP with no activity this long → alert
const BIG_WITHDRAWAL_MIN = 50000; // withdrawal ≥ this (INR) → alert
const FTD_DROP_RATIO = 0.5;       // today's FTDs below this fraction of the daily avg → alert
const FTD_MIN_BASELINE = 3;       // only alert on FTD drop when the avg is at least this

// --- Health / drift monitor ---
const STALE_TXN_HOURS = 12;       // no new transactions in this long → maybe the webhook froze
const WA_FAIL_MIN_VOLUME = 10;    // only judge the WhatsApp failure rate above this many sends
const WA_FAIL_RATE_PCT = 25;      // failed/(sent+failed) over this % → alert

export type HealthCheck = { name: string; label: string; ok: boolean; count: number; detail: string; severity: 'high' | 'medium' };

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
      this.detectHealth(tenantId),
    ]);
    const created = counts.reduce((a, b) => a + b, 0);
    if (created) this.log.log(`${tenantId}: ${created} new alert(s)`);
    return { created };
  }

  /** Run every health/drift check and return the full report (pass + fail). Read-only —
   * this NEVER mutates data or creates alerts; it's the status board. */
  async healthReport(tenantId: string): Promise<HealthCheck[]> {
    const one = async (
      name: string, label: string, severity: 'high' | 'medium',
      sql: string, params: unknown[], bad: (n: number) => boolean, detail: (n: number) => string,
    ): Promise<HealthCheck> => {
      try {
        const rows = await this.prisma.$queryRawUnsafe<Array<{ cnt: number }>>(sql, ...params);
        const count = Number(rows[0]?.cnt ?? 0);
        return { name, label, severity, count, ok: !bad(count), detail: detail(count) };
      } catch (e) {
        // A check that errors is itself a problem worth surfacing (not a silent pass).
        return { name, label, severity, count: -1, ok: false, detail: `check failed: ${e instanceof Error ? e.message : e}` };
      }
    };

    return Promise.all([
      // The exact bug that stranded 50 leads: a deposit on record but deposit_count = 0.
      one('deposit_count_drift', 'Deposit-count drift', 'high',
        `select count(*)::int cnt from saas.customers where tenant_id=$1 and coalesce(deposit_count,0)=0 and last_deposit_at is not null`,
        [tenantId], (n) => n > 0, (n) => n > 0 ? `${n} players have a deposit on record but deposit_count = 0 (stuck as leads)` : 'No drift'),
      // Depositors still sitting in a lead stage = classification didn't recompute.
      one('leads_with_deposits', 'Depositors stuck as leads', 'high',
        `select count(*)::int cnt from saas.customers where tenant_id=$1 and current_lifecycle in ('Lead','Registered') and coalesce(deposit_count,0) > 0`,
        [tenantId], (n) => n > 0, (n) => n > 0 ? `${n} depositors are classified as leads (stage not recomputed)` : 'All stages consistent'),
      // The join-date bug we just fixed: registered "after" the record was created.
      one('mis_stamped_registration', 'Bad join dates', 'medium',
        `select count(*)::int cnt from saas.customers where tenant_id=$1 and registration_at > created_at + interval '1 hour'`,
        [tenantId], (n) => n > 0, (n) => n > 0 ? `${n} players have a join date after their record was created (bad stamp)` : 'Join dates clean'),
      // The frozen-source bug: no transactions arriving means the webhook may be dead. GLOBAL.
      one('stale_transactions', 'Transaction feed', 'high',
        `select coalesce(round(extract(epoch from (now() - max(occurred_at)))/3600), 9999)::int cnt from saas.transactions`,
        [], (n) => n > STALE_TXN_HOURS, (n) => n > STALE_TXN_HOURS ? `No new transactions in ${n}h — the webhook may have stopped` : `Last transaction ${n}h ago`),
      // WhatsApp sends mostly failing = a template/key/number problem.
      one('whatsapp_failure_rate', 'WhatsApp delivery', 'medium',
        `select case when count(*) filter (where status in ('sent','failed')) >= ${WA_FAIL_MIN_VOLUME}
           then coalesce(round(100.0 * count(*) filter (where status='failed') / nullif(count(*) filter (where status in ('sent','failed')),0)),0) else 0 end::int cnt
         from public.message_log where tenant_id=$1::uuid and created_at >= now() - interval '24 hours'`,
        [tenantId], (n) => n > WA_FAIL_RATE_PCT, (n) => n > WA_FAIL_RATE_PCT ? `${n}% of WhatsApp sends failed in the last 24h` : 'Delivery healthy'),
    ]);
  }

  /** Turn failing health checks into alerts (deduped per day). Returns how many were new. */
  private async detectHealth(tenantId: string): Promise<number> {
    const report = await this.healthReport(tenantId);
    let created = 0;
    for (const c of report.filter((x) => !x.ok)) {
      const n = await this.prisma.$executeRawUnsafe(
        `insert into saas.alerts (alert_key, tenant_id, type, severity, title, body)
         values ($1, $2, $3, $4, $5, $6) on conflict (alert_key) do nothing`,
        `health|${c.name}|${tenantId}|${new Date().toISOString().slice(0, 10)}`,
        tenantId, `health:${c.name}`, c.severity, `Data health: ${c.label}`, c.detail,
      );
      created += n;
    }
    return created;
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
