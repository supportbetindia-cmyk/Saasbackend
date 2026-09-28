import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

type LegacyTenant = { id: string; name: string };

export type CustomerRowInput = {
  externalUserId: string;
  masterId?: string | null;
  name?: string | null;
  phone?: string | null;
  registrationAt?: string | null;
  accountStatus?: string | null;
  currentCategory?: string | null;
  ftdDate?: string | null;
  ftdAmount?: number | null;
  totalDeposits?: number | null;
  depositCount?: number | null;
  totalWithdrawals?: number | null;
  withdrawalCount?: number | null;
  netPnl?: number | null;
  totalBonus?: number | null;
  lastDepositAt?: string | null;
  lastDepositAmount?: number | null;
  lastWithdrawalAt?: string | null;
  lastWithdrawalAmount?: number | null;
};

@Injectable()
export class ImportsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Bulk upsert customers parsed from an uploaded CSV (any tenant, no legacy tables
   * needed). One INSERT..SELECT over unnest(arrays) so a whole file lands in one
   * round-trip. Deduped by external user id (last row wins); idempotent on
   * (tenant, external_user_id) — re-uploading refreshes existing customers.
   */
  async importCustomerRows(tenantId: string, rows: CustomerRowInput[]) {
    const byId = new Map<string, CustomerRowInput>();
    for (const row of rows) {
      const id = (row.externalUserId ?? '').trim();
      if (id) byId.set(id, row);
    }
    const list = [...byId.values()];
    if (list.length === 0) return { received: rows.length, deduped: 0, processed: 0 };

    const str = (v: unknown) => (v == null ? '' : String(v));
    const externalUserId = list.map((r) => str(r.externalUserId).trim());
    const masterId = list.map((r) => str(r.masterId));
    const name = list.map((r) => str(r.name));
    const phone = list.map((r) => str(r.phone));
    const registrationAt = list.map((r) => str(r.registrationAt));
    const accountStatus = list.map((r) => str(r.accountStatus));
    const currentCategory = list.map((r) => str(r.currentCategory));
    const ftdDate = list.map((r) => str(r.ftdDate));
    const ftdAmount = list.map((r) => str(r.ftdAmount));
    const totalDeposits = list.map((r) => str(r.totalDeposits));
    const depositCount = list.map((r) => str(r.depositCount));
    const totalWithdrawals = list.map((r) => str(r.totalWithdrawals));
    const withdrawalCount = list.map((r) => str(r.withdrawalCount));
    const netPnl = list.map((r) => str(r.netPnl));
    const totalBonus = list.map((r) => str(r.totalBonus));
    const lastDepositAt = list.map((r) => str(r.lastDepositAt));
    const lastDepositAmount = list.map((r) => str(r.lastDepositAmount));
    const lastWithdrawalAt = list.map((r) => str(r.lastWithdrawalAt));
    const lastWithdrawalAmount = list.map((r) => str(r.lastWithdrawalAmount));

    const sql = `
      insert into saas.customers
        (id, tenant_id, external_user_id, master_id, name, phone, phone_normalized,
         registration_at, account_status, current_category, ftd_date, ftd_amount,
         total_deposits, deposit_count, total_withdrawals, withdrawal_count, net_pnl,
         total_bonus, last_deposit_at, last_deposit_amount, last_withdrawal_at,
         last_withdrawal_amount, created_at, updated_at)
      select gen_random_uuid()::text, $1, t.external_user_id,
             nullif(t.master_id, ''), nullif(t.name, ''), nullif(t.phone, ''),
             right(regexp_replace(coalesce(t.phone, ''), '[^0-9]', '', 'g'), 10),
             nullif(t.registration_at, '')::timestamptz,
             nullif(t.account_status, ''), nullif(t.current_category, ''),
             nullif(t.ftd_date, '')::timestamptz,
             nullif(t.ftd_amount, '')::numeric,
             nullif(t.total_deposits, '')::numeric, nullif(t.deposit_count, '')::int,
             nullif(t.total_withdrawals, '')::numeric, nullif(t.withdrawal_count, '')::int,
             nullif(t.net_pnl, '')::numeric, nullif(t.total_bonus, '')::numeric,
             nullif(t.last_deposit_at, '')::timestamptz, nullif(t.last_deposit_amount, '')::numeric,
             nullif(t.last_withdrawal_at, '')::timestamptz, nullif(t.last_withdrawal_amount, '')::numeric,
             now(), now()
      from unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::text[],
                  $7::text[], $8::text[], $9::text[], $10::text[], $11::text[],
                  $12::text[], $13::text[], $14::text[], $15::text[], $16::text[],
                  $17::text[], $18::text[], $19::text[], $20::text[])
        as t(external_user_id, master_id, name, phone, registration_at,
              account_status, current_category, ftd_date, ftd_amount,
              total_deposits, deposit_count, total_withdrawals, withdrawal_count, net_pnl,
              total_bonus, last_deposit_at, last_deposit_amount, last_withdrawal_at,
              last_withdrawal_amount)
      where t.external_user_id is not null and btrim(t.external_user_id) <> ''
      on conflict (tenant_id, external_user_id) do update set
        master_id        = coalesce(nullif(excluded.master_id, ''), saas.customers.master_id),
        name             = coalesce(excluded.name, saas.customers.name),
        phone            = excluded.phone,
        phone_normalized = excluded.phone_normalized,
        registration_at  = coalesce(excluded.registration_at, saas.customers.registration_at),
        account_status   = excluded.account_status,
        current_category = excluded.current_category,
        ftd_date         = coalesce(excluded.ftd_date, saas.customers.ftd_date),
        ftd_amount       = coalesce(excluded.ftd_amount, saas.customers.ftd_amount),
        total_deposits   = coalesce(excluded.total_deposits, saas.customers.total_deposits),
        deposit_count    = coalesce(excluded.deposit_count, saas.customers.deposit_count),
        total_withdrawals = coalesce(excluded.total_withdrawals, saas.customers.total_withdrawals),
        withdrawal_count = coalesce(excluded.withdrawal_count, saas.customers.withdrawal_count),
        net_pnl          = coalesce(excluded.net_pnl, saas.customers.net_pnl),
        total_bonus      = coalesce(excluded.total_bonus, saas.customers.total_bonus),
        -- Forward-only: don't let an older CSV snapshot move the last-deposit/withdrawal
        -- marker backward over what live webhooks already recorded.
        last_deposit_at  = case when excluded.last_deposit_at is not null
             and (saas.customers.last_deposit_at is null or excluded.last_deposit_at > saas.customers.last_deposit_at)
          then excluded.last_deposit_at else saas.customers.last_deposit_at end,
        last_deposit_amount = case when excluded.last_deposit_at is not null
             and (saas.customers.last_deposit_at is null or excluded.last_deposit_at > saas.customers.last_deposit_at)
          then excluded.last_deposit_amount else saas.customers.last_deposit_amount end,
        last_withdrawal_at = case when excluded.last_withdrawal_at is not null
             and (saas.customers.last_withdrawal_at is null or excluded.last_withdrawal_at > saas.customers.last_withdrawal_at)
          then excluded.last_withdrawal_at else saas.customers.last_withdrawal_at end,
        last_withdrawal_amount = case when excluded.last_withdrawal_at is not null
             and (saas.customers.last_withdrawal_at is null or excluded.last_withdrawal_at > saas.customers.last_withdrawal_at)
          then excluded.last_withdrawal_amount else saas.customers.last_withdrawal_amount end,
        updated_at       = now();
    `;
    const processed = await this.prisma.$executeRawUnsafe(
      sql, tenantId, externalUserId, masterId, name, phone,
      registrationAt, accountStatus, currentCategory, ftdDate, ftdAmount,
      totalDeposits, depositCount, totalWithdrawals, withdrawalCount, netPnl,
      totalBonus, lastDepositAt, lastDepositAmount, lastWithdrawalAt, lastWithdrawalAmount,
    );
    return { received: rows.length, deduped: list.length, processed };
  }

  /**
   * Find the single legacy (public.tenants) company that matches this SaaS tenant by
   * name. The legacy tables key their rows on that id, so we resolve it before copying.
   */
  private async resolveLegacyTenant(tenantName: string): Promise<LegacyTenant> {
    const legacyTenants = await this.prisma.$queryRaw<LegacyTenant[]>`
      select id::text, name
      from public.tenants
      where lower(name) = lower(${tenantName})
      order by created_at asc
      limit 2
    `;
    if (legacyTenants.length === 0) {
      throw new BadRequestException(`No legacy company named "${tenantName}" was found`);
    }
    if (legacyTenants.length > 1) {
      throw new BadRequestException(`More than one legacy company named "${tenantName}" exists`);
    }
    return legacyTenants[0];
  }

  /**
   * One-shot bridge from legacy public.users into saas.customers for this tenant. Runs
   * as a single INSERT..SELECT..ON CONFLICT so tens of thousands of rows import in one
   * DB round-trip (seconds), not one round-trip per row. Idempotent on
   * (tenant, external_user_id); re-running updates the existing rows.
   */
  async importLegacyCustomers(tenantId: string, tenantName: string) {
    const legacyTenant = await this.resolveLegacyTenant(tenantName);
    const sql = `
      insert into saas.customers
        (id, tenant_id, external_user_id, master_id, name, phone, phone_normalized,
         registration_at, account_status, current_category, ftd_date, ftd_amount,
         total_deposits, deposit_count, total_withdrawals, withdrawal_count, net_pnl,
         total_bonus, last_deposit_at, last_deposit_amount, last_withdrawal_at,
         last_withdrawal_amount, created_at, updated_at)
      select gen_random_uuid()::text, $1, u.user_id,
             nullif(u.branch_id, ''),
             nullif(u.name, '0'),
             u.mobile,
             right(regexp_replace(coalesce(u.mobile, ''), '[^0-9]', '', 'g'), 10),
             u.register_date, u.status_label, u.category,
             u.first_deposit_date,
             nullif(btrim(u.first_deposit_amount::text), '')::numeric,
             u.total_deposit, u.deposit_count, u.total_withdrawal, u.withdrawal_count, u.pnl,
             u.total_bonus, u.last_deposit_date, u.last_deposit_amount, u.last_withdrawal_date,
             u.last_withdrawal_amount, now(), now()
      from (
        select distinct on (user_id) *
        from public.users
        -- ponytail: single legacy tenant, so untagged (null) rows are also its own.
        -- Lets live webhook rows sync in without writing tenant_id back to public.
        where (tenant_id = $2::uuid or tenant_id is null)
          and user_id is not null and btrim(user_id) <> ''
        order by user_id, created_at desc
      ) u
      on conflict (tenant_id, external_user_id) do update set
        master_id        = coalesce(nullif(excluded.master_id, ''), saas.customers.master_id),
        name             = coalesce(excluded.name, saas.customers.name),
        phone            = excluded.phone,
        phone_normalized = excluded.phone_normalized,
        registration_at  = excluded.registration_at,
        account_status   = excluded.account_status,
        current_category = excluded.current_category,
        ftd_date         = excluded.ftd_date,
        ftd_amount       = excluded.ftd_amount,
        total_deposits   = excluded.total_deposits,
        deposit_count    = excluded.deposit_count,
        total_withdrawals = excluded.total_withdrawals,
        withdrawal_count = excluded.withdrawal_count,
        net_pnl          = excluded.net_pnl,
        total_bonus      = excluded.total_bonus,
        -- Forward-only: the legacy users table is a frozen snapshot; never move the
        -- last-deposit/withdrawal marker BACKWARD over what live webhooks recorded.
        last_deposit_at  = case when excluded.last_deposit_at is not null
             and (saas.customers.last_deposit_at is null or excluded.last_deposit_at > saas.customers.last_deposit_at)
          then excluded.last_deposit_at else saas.customers.last_deposit_at end,
        last_deposit_amount = case when excluded.last_deposit_at is not null
             and (saas.customers.last_deposit_at is null or excluded.last_deposit_at > saas.customers.last_deposit_at)
          then excluded.last_deposit_amount else saas.customers.last_deposit_amount end,
        last_withdrawal_at = case when excluded.last_withdrawal_at is not null
             and (saas.customers.last_withdrawal_at is null or excluded.last_withdrawal_at > saas.customers.last_withdrawal_at)
          then excluded.last_withdrawal_at else saas.customers.last_withdrawal_at end,
        last_withdrawal_amount = case when excluded.last_withdrawal_at is not null
             and (saas.customers.last_withdrawal_at is null or excluded.last_withdrawal_at > saas.customers.last_withdrawal_at)
          then excluded.last_withdrawal_amount else saas.customers.last_withdrawal_amount end,
        updated_at       = now();
    `;
    const processed = await this.prisma.$executeRawUnsafe(sql, tenantId, legacyTenant.id);
    return {
      sourceTenant: { id: legacyTenant.id, name: legacyTenant.name },
      destinationTenant: { id: tenantId, name: tenantName },
      processed,
    };
  }

  /**
   * One-shot bridge from legacy public.transactions into saas.transactions for this
   * tenant. Each row is linked to its customer by external User ID (join), so run the
   * customers import first — transactions with no matching customer are skipped and
   * reported. Status is classified with the same rejected-first rules as
   * transactions/status.ts. The saas ledger is unique on (tenant, source,
   * external_transaction_id), so we keep the latest row per transaction_id. Idempotent.
   */
  async importLegacyTransactions(tenantId: string, tenantName: string) {
    const legacyTenant = await this.resolveLegacyTenant(tenantName);

    const insertSql = `
      insert into saas.transactions
        (id, tenant_id, customer_id, external_transaction_id, source, transaction_type,
         amount, currency, occurred_at, raw_status, normalized_status,
         is_financially_successful, remarks, created_at, updated_at)
      select gen_random_uuid()::text, $1, c.id, t.transaction_id, 'legacy',
             (case when lower(coalesce(t.type, '')) ~ 'withdraw' then 'WITHDRAWAL'
                   else 'DEPOSIT' end)::saas."TransactionType",
             coalesce(t.amount, 0), 'INR', coalesce(t.created_at, now()),
             t.payment_status,
             (case
                when lower(coalesce(t.payment_status, '')) ~ 'no statement|absent|reject|declin|cancel' then 'REJECTED'
                when lower(coalesce(t.payment_status, '')) ~ 'fail' then 'FAILED'
                when lower(coalesce(t.payment_status, '')) ~ 'approv|success|complet|credit' then 'APPROVED'
                else 'PENDING' end)::saas."TxnStatus",
             (lower(coalesce(t.payment_status, '')) ~ 'approv|success|complet|credit'
              and lower(coalesce(t.payment_status, '')) !~ 'no statement|absent|reject|declin|cancel|fail'),
             t.remarks, now(), now()
      from (
        select distinct on (transaction_id) *
        from public.transactions
        -- ponytail: single legacy tenant, so untagged (null) rows are also its own.
        where (tenant_id::text = $2 or tenant_id is null)
          and transaction_id is not null and btrim(transaction_id) <> ''
          and user_id is not null and btrim(user_id) <> ''
        order by transaction_id, created_at desc
      ) t
      join saas.customers c on c.tenant_id = $1 and c.external_user_id = t.user_id
      on conflict (tenant_id, source, external_transaction_id) do update set
        customer_id               = excluded.customer_id,
        transaction_type          = excluded.transaction_type,
        amount                    = excluded.amount,
        occurred_at               = excluded.occurred_at,
        raw_status                = excluded.raw_status,
        normalized_status         = excluded.normalized_status,
        is_financially_successful = excluded.is_financially_successful,
        remarks                   = excluded.remarks,
        updated_at                = now();
    `;
    const processed = await this.prisma.$executeRawUnsafe(insertSql, tenantId, legacyTenant.id);

    // Count unique legacy transactions whose customer isn't in this tenant yet.
    const skippedRows = await this.prisma.$queryRawUnsafe<{ skipped: number }[]>(
      `
      select count(*)::int as skipped
      from (
        select distinct on (transaction_id) transaction_id, user_id
        from public.transactions
        where tenant_id::text = $1
          and transaction_id is not null and btrim(transaction_id) <> ''
          and user_id is not null and btrim(user_id) <> ''
        order by transaction_id, created_at desc
      ) t
      left join saas.customers c on c.tenant_id = $2 and c.external_user_id = t.user_id
      where c.id is null
      `,
      legacyTenant.id,
      tenantId,
    );

    // Imports can add deposits OLDER than one already processed live, which would
    // leave the first-deposit date stale. Re-derive it from the earliest deposit.
    await this.recomputeFtd(tenantId);

    return {
      sourceTenant: { id: legacyTenant.id, name: legacyTenant.name },
      destinationTenant: { id: tenantId, name: tenantName },
      skippedNoCustomer: skippedRows[0]?.skipped ?? 0,
      processed,
    };
  }

  /** Set each customer's first-deposit (FTD) date/amount from their earliest successful
   * deposit. Only ever moves the FTD EARLIER (or fills a blank), so it can never make a
   * correct date later. Returns the number of customers corrected. */
  async recomputeFtd(tenantId: string): Promise<number> {
    return this.prisma.$executeRawUnsafe(
      `update saas.customers c
          set ftd_date = f.first_at, ftd_amount = f.first_amount, updated_at = now()
         from (
           select customer_id, min(occurred_at) as first_at,
                  (array_agg(amount order by occurred_at asc, id asc))[1] as first_amount
             from saas.transactions
            where tenant_id = $1 and transaction_type = 'DEPOSIT' and is_financially_successful
            group by customer_id
         ) f
        where c.id = f.customer_id and c.tenant_id = $1
          and (c.ftd_date is null or f.first_at < c.ftd_date)`,
      tenantId,
    );
  }
}
