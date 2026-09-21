alter table saas.tenants
  add column if not exists webhook_key text,
  add column if not exists webhook_secret_hash text,
  add column if not exists webhook_enabled boolean not null default true;

update saas.tenants
set webhook_key = gen_random_uuid()::text
where webhook_key is null;

alter table saas.tenants
  alter column webhook_key set not null,
  alter column webhook_key set default gen_random_uuid()::text;

create unique index if not exists tenants_webhook_key_key
  on saas.tenants (webhook_key);
