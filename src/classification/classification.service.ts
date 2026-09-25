import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CLASSIFICATION_CONFIG, parseClassificationConfig, type ClassificationConfig } from './classification.config';

@Injectable()
export class ClassificationService {
  constructor(private readonly prisma: PrismaService) {}

  /** The tenant's classification config — its saved overrides, or the code defaults. */
  async getConfig(tenantId: string): Promise<ClassificationConfig> {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { classificationConfig: true },
    });
    return tenant?.classificationConfig
      ? parseClassificationConfig(tenant.classificationConfig)
      : CLASSIFICATION_CONFIG;
  }

  /** Save (validated) thresholds for a tenant and return the normalized config. */
  async saveConfig(tenantId: string, input: unknown): Promise<ClassificationConfig> {
    const cfg = parseClassificationConfig(input);
    await this.prisma.tenant.update({ where: { id: tenantId }, data: { classificationConfig: cfg } });
    return cfg;
  }

  /** SQL CASE that derives a customer's lifecycle stage from their stored numbers. */
  private lifecycleCase(cfg: ClassificationConfig): string {
    const { atRiskDays, inactiveDays } = cfg.inactivity;
    const regular = cfg.regularPlayerMinDeposits;
    return `case
      when coalesce(deposit_count, 0) = 0
        then case when registration_at is not null then 'Registered' else 'Lead' end
      when last_deposit_at is not null and now() - last_deposit_at > interval '${inactiveDays} days' then 'Inactive'
      when last_deposit_at is not null and now() - last_deposit_at > interval '${atRiskDays} days' then 'At Risk'
      when coalesce(deposit_count, 0) = 1 then 'FTD'
      when coalesce(deposit_count, 0) >= ${regular} then 'Regular Player'
      else 'Repeat Depositor'
    end`;
  }

  /** SQL CASE that derives a customer's value tier from lifetime total deposits. */
  private categoryCase(cfg: ClassificationConfig): string {
    const branches = [...cfg.valueTiers]
      .sort((a, b) => b.min - a.min)
      .map((t) => `when coalesce(total_deposits, 0) >= ${t.min} then '${t.name}'`)
      .join('\n      ');
    return `case
      ${branches}
      else null
    end`;
  }

  /**
   * Recalculate lifecycle + value tier for every customer in the tenant. Any change is
   * written to classification_events (history is never overwritten, PRD 6.2). Runs as a
   * single writable-CTE statement so 5k+ customers reclassify in one DB round-trip.
   * Idempotent: re-running with no changes writes nothing.
   */
  async recomputeTenant(tenantId: string, reason = 'Auto recalculated'): Promise<{ changed: number }> {
    const cfg = await this.getConfig(tenantId);
    const sql = `
      with computed as (
        select id, current_lifecycle as old_lc, current_category as old_cat,
               (${this.lifecycleCase(cfg)}) as new_lc,
               (${this.categoryCase(cfg)}) as new_cat
        from saas.customers
        where tenant_id = $1
      ),
      lc as (
        insert into saas.classification_events
          (id, tenant_id, customer_id, dimension, old_value, new_value, reason, changed_at)
        select gen_random_uuid()::text, $1, id, 'lifecycle', old_lc, new_lc, $2, now()
        from computed where new_lc is distinct from old_lc
        returning 1
      ),
      cat as (
        insert into saas.classification_events
          (id, tenant_id, customer_id, dimension, old_value, new_value, reason, changed_at)
        select gen_random_uuid()::text, $1, id, 'category', old_cat, new_cat, $2, now()
        from computed where new_cat is distinct from old_cat
        returning 1
      )
      update saas.customers c
      set current_lifecycle = comp.new_lc, current_category = comp.new_cat, updated_at = now()
      from computed comp
      where c.id = comp.id
        and (comp.new_lc is distinct from c.current_lifecycle
             or comp.new_cat is distinct from c.current_category);
    `;
    const changed = await this.prisma.$executeRawUnsafe(sql, tenantId, reason);
    return { changed };
  }

  /** How many customers sit in each lifecycle stage and value tier right now. */
  async summary(tenantId: string) {
    const [lifecycle, category] = await Promise.all([
      this.prisma.$queryRawUnsafe<{ key: string | null; count: number }[]>(
        `select current_lifecycle as key, count(*)::int as count
         from saas.customers where tenant_id = $1 group by current_lifecycle order by count desc`,
        tenantId,
      ),
      this.prisma.$queryRawUnsafe<{ key: string | null; count: number }[]>(
        `select current_category as key, count(*)::int as count
         from saas.customers where tenant_id = $1 group by current_category order by count desc`,
        tenantId,
      ),
    ]);
    return { lifecycle, category };
  }

  async scheduleStatus(tenantId: string) {
    const [tenant, lastRun, cfg] = await Promise.all([
      this.prisma.tenant.findUnique({ where: { id: tenantId }, select: { timezone: true } }),
      this.prisma.auditLog.findFirst({ where: { tenantId, action: 'classification.scheduled' }, orderBy: { createdAt: 'desc' }, select: { createdAt: true, newValue: true } }),
      this.getConfig(tenantId),
    ]);
    return {
      enabled: true,
      timezone: tenant?.timezone || 'Asia/Kolkata',
      atRiskDays: cfg.inactivity.atRiskDays,
      inactiveDays: cfg.inactivity.inactiveDays,
      lastRunAt: lastRun?.createdAt ?? null,
      lastResult: lastRun?.newValue ?? null,
    };
  }

  /** Recent lifecycle/tier changes for one customer (for Customer 360). */
  async historyFor(tenantId: string, customerId: string, limit = 20) {
    return this.prisma.classificationEvent.findMany({
      where: { tenantId, customerId },
      orderBy: { changedAt: 'desc' },
      take: limit,
    });
  }
}
