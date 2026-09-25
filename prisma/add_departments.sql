create table if not exists saas.departments (
  id text primary key default gen_random_uuid()::text,
  tenant_id text not null references saas.tenants(id) on delete cascade,
  name text not null,
  sort_order integer not null default 0,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, name)
);

create index if not exists departments_tenant_archived_sort_idx
  on saas.departments (tenant_id, archived_at, sort_order);
