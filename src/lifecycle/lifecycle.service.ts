import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

// Placeholder thresholds — a later phase makes these per-tenant configurable.
const INACTIVE_DAYS = 30;      // no deposit/withdrawal for this long → INACTIVE
const FTD_NO_REPEAT_DAYS = 7;  // one deposit and no repeat within this → FTD_NO_REPEAT

@Injectable()
export class LifecycleService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * SQL CASE deriving a customer's BASE lifecycle stage from stored fields. First
   * match wins, so order matters. Produces 6 stages; REACTIVATED is a transition,
   * layered on in recompute() (you can't see it from current state alone).
   */
  private stageCase(): string {
    return `case
      when registration_at is null then 'LEAD'
      when coalesce(deposit_count, 0) = 0 then 'REGISTERED_NO_FTD'
      when greatest(last_deposit_at, last_withdrawal_at) is not null
        and now() - greatest(last_deposit_at, last_withdrawal_at) > interval '${INACTIVE_DAYS} days' then 'INACTIVE'
      when deposit_count = 1 and ftd_date is not null
        and now() - ftd_date <= interval '${FTD_NO_REPEAT_DAYS} days' then 'FTD'
      when deposit_count = 1 then 'FTD_NO_REPEAT'
      else 'ACTIVE'
    end`;
  }

  /** The writable CTE that reclassifies a scope of customers: compute base stage,
   * resolve the REACTIVATED transition, log every change to classification_events,
   * then write current_stage. `scope` limits which rows (whole tenant, or one id). */
  private recomputeSql(scope: string): string {
    return `
      with computed as (
        select id, current_stage as old_stage, (${this.stageCase()}) as base_stage
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
      set current_stage = r.new_stage, stage_changed_at = now(), updated_at = now()
      from resolved r
      where c.id = r.id and r.new_stage is distinct from c.current_stage;
    `;
  }

  /** Recompute every customer in a tenant (daily job / manual). Idempotent. */
  async recomputeTenant(tenantId: string, reason = 'Auto recalculated'): Promise<{ changed: number }> {
    const changed = await this.prisma.$executeRawUnsafe(this.recomputeSql('tenant_id = $1'), tenantId, reason);
    return { changed };
  }

  /** Recompute one customer (cheap — call from the webhook after a transaction). */
  async recomputeCustomer(tenantId: string, customerId: string): Promise<void> {
    await this.prisma.$executeRawUnsafe(
      this.recomputeSql('tenant_id = $1 and id = $3'), tenantId, 'webhook', customerId,
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
