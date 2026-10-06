-- Per-member master restriction. Empty array = access to all masters.
alter table saas.tenant_memberships add column if not exists master_ids text[] not null default '{}';
