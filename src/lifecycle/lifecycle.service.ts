import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { LIFECYCLE_CONFIG, parseLifecycleConfig, type LifecycleConfig } from './lifecycle.config';

@Injectable()
export class LifecycleService {
  constructor(private readonly prisma: PrismaService) {}

  /** The tenant's saved thresholds, or the code defaults. Values are always safe
   * positive ints (parseLifecycleConfig), so they're OK to interpolate into SQL. */
  async getConfig(tenantId: string): Promise<LifecycleConfig> {
    const rows = await this.prisma.$queryRawUnsafe<{ lifecycle_config: unknown }[]>(
      `select lifecycle_config from saas.tenants where id = $1`, tenantId,
    );
    const saved = rows[0]?.lifecycle_config;
    return saved ? parseLifecycleConfig(saved) : LIFECYCLE_CONFIG;
  }

  /** Save (validated) thresholds for a tenant and return the normalized config. */
  async saveConfig(tenantId: string, input: unknown): Promise<LifecycleConfig> {
    const cfg = parseLifecycleConfig(input);
    await this.prisma.$executeRawUnsafe(
      `update saas.tenants set lifecycle_config = $2::jsonb, updated_at = now() where id = $1`,
      tenantId, JSON.stringify(cfg),
    );
    return cfg;
  }

  /**
   * SQL CASE deriving a customer's BASE lifecycle stage from stored fields. First
   * match wins, so order matters. Produces 6 stages; REACTIVATED is a transition,
   * layered on in recompute() (you can't see it from current state alone).
   */
  private stageCase(cfg: LifecycleConfig): string {
    return `case
      when registration_at is null then 'LEAD'
      when coalesce(deposit_count, 0) = 0 then 'REGISTERED_NO_FTD'
      when greatest(last_deposit_at, last_withdrawal_at) is not null
        and now() - greatest(last_deposit_at, last_withdrawal_at) > interval '${cfg.inactiveDays} days' then 'INACTIVE'
      when deposit_count = 1 and ftd_date is not null
        and now() - ftd_date <= interval '${cfg.ftdNoRepeatDays} days' then 'FTD'
      when deposit_count = 1 then 'FTD_NO_REPEAT'
      else 'ACTIVE'
    end`;
  }

  /** The writable CTE that reclassifies a scope of customers: compute base stage,
   * resolve the REACTIVATED transition, log every change to classification_events,
   * then write current_stage. `scope` limits which rows (whole tenant, or one id). */
  private recomputeSql(scope: string, cfg: LifecycleConfig): string {
    return `
      with computed as (
        select id, current_stage as old_stage, (${this.stageCase(cfg)}) as base_stage
        from saas.customers
        where ${scope}
      ),
      resolved as (
        select id, old_stage,
               -- Coming back from INACTIVE to any active-ish stage is a REACTIVATED milestone.
               case when old_stage = 'INACTIVE' and base_stage in ('ACTIVE', 'FTD', 'FTD_NO_REPEAT')
                    then 'REACTIVATED' else base_stage end as new_stage
        from computed
      ),
      hist as (
        insert into saas.classification_events
          (id, tenant_id, customer_id, dimension, old_value, new_value, reason, changed_at)
        select gen_random_uuid()::text, $1, id, 'stage', old_stage, new_stage, $2, now()
        from resolved where new_stage is distinct from old_stage
        returning 1
      )
      update saas.customers c
      set current_stage = r.new_stage, stage_changed_at = now(),
          -- Cancel-on-transition: a new stage starts its follow-ups from zero, so
          -- old-stage nudges stop and the new stage isn't already "capped".
          follow_up_count = 0,
          updated_at = now()
      from resolved r
      where c.id = r.id and r.new_stage is distinct from c.current_stage;
    `;
  }

  /** Recompute every customer in a tenant (daily job / manual). Idempotent. */
  async recomputeTenant(tenantId: string, reason = 'Auto recalculated'): Promise<{ changed: number }> {
    const cfg = await this.getConfig(tenantId);
    const changed = await this.prisma.$executeRawUnsafe(this.recomputeSql('tenant_id = $1', cfg), tenantId, reason);
    return { changed };
  }

  /** Recompute one customer (cheap — call from the webhook after a transaction). */
  async recomputeCustomer(tenantId: string, customerId: string): Promise<void> {
    const cfg = await this.getConfig(tenantId);
    await this.prisma.$executeRawUnsafe(
      this.recomputeSql('tenant_id = $1 and id = $3', cfg), tenantId, 'webhook', customerId,
    );
  }

  /** How many customers sit in each stage right now (for the UI). */
  async summary(tenantId: string) {
    return this.prisma.$queryRawUnsafe<{ key: string | null; count: number }[]>(
      `select current_stage as key, count(*)::int as count
       from saas.customers where tenant_id = $1 group by current_stage order by count desc`,
      tenantId,
    );
  }
}
