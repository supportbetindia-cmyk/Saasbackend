-- Scaling prep: indexes for hot filters/sorts + a per-tenant metrics materialized view.
-- Safe to run repeatedly (IF NOT EXISTS). Apply to any fresh database.
-- Already applied to production on 2026-10-03.

-- ---------- Indexes (CONCURRENTLY = no table lock; run each outside a transaction) ----------
create index concurrently if not exists customers_tenant_stage_idx
  on saas.customers (tenant_id, current_stage);          -- lifecycle sender eligible()
create index concurrently if not exists customers_tenant_lifecycle_idx
  on saas.customers (tenant_id, current_lifecycle);      -- Players stage filter + classification
create index concurrently if not exists customers_tenant_totaldep_idx
  on saas.customers (tenant_id, total_deposits desc nulls last); -- Players list sort
create index concurrently if not exists message_log_failed_retry_idx
  on public.message_log (status, next_attempt_at) where status = 'failed'; -- retry worker

-- ---------- Metrics materialized view (customer-side rollup per tenant) ----------
-- Read by DashboardService.userAnalytics() when USE_METRICS_MV=1 (and no master filter).
-- Refreshed by the LiveSync tick (REFRESH MATERIALIZED VIEW CONCURRENTLY).
create materialized view if not exists saas.mv_tenant_metrics as
select
  tenant_id,
  count(*)::int as registered_users,
  count(*) filter (where coalesce(deposit_count,0) > 0)::int as depositors,
  count(*) filter (where coalesce(deposit_count,0) = 0)::int as never_deposited,
  coalesce(sum(total_deposits),0)::float8 as deposit_total,
  coalesce(sum(total_withdrawals),0)::float8 as withdrawal_total,
  coalesce(avg(ftd_amount) filter (where ftd_amount is not null),0)::float8 as avg_first_deposit,
  count(*) filter (where registration_at >= now() - interval '7 days')::int as new7,
  count(*) filter (where registration_at >= now() - interval '30 days')::int as new30,
  count(*) filter (where coalesce(deposit_count,0) > 0
    and coalesce(greatest(last_deposit_at, last_withdrawal_at), to_timestamp(0)) < now() - interval '30 days')::int as dormant_depositors,
  now() as refreshed_at
from saas.customers
group by tenant_id;

-- Unique index is REQUIRED for REFRESH MATERIALIZED VIEW CONCURRENTLY.
create unique index if not exists mv_tenant_metrics_pk on saas.mv_tenant_metrics (tenant_id);
