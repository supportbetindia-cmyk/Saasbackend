# Customer Intelligence & Company Growth SaaS — Backend

Multi-tenant **NestJS + Prisma + PostgreSQL** backend. Auth via **Supabase Auth**
(the backend verifies Supabase access tokens). Phase 1 = Foundation (tenants,
users, memberships, RBAC, audit, health).

## Stack
NestJS · Prisma · PostgreSQL (new Supabase project) · Supabase Auth (JWT) ·
class-validator. Redis/BullMQ + S3 come in later phases (jobs, imports/exports).

## Multi-tenancy (important)
All clients (BetIndia, 1xplay, …) share **one** database and **one** set of tables.
Every tenant-owned row carries `tenant_id`; the app + Postgres RLS ensure a client
only ever sees its own rows. **Onboarding a new client = inserting a `tenants` row**
— no new database, no new tables, no redeploy.

The SaaS tables live in a dedicated **`saas`** Postgres schema so they never touch
the existing BetIndia tables in `public`.

## One-time setup (reusing your existing Supabase project)

1. **Take a backup** of the Supabase project first (safe, but do it).
2. Copy env: `cp .env.example .env` and fill in (from your EXISTING project):
   - `DATABASE_URL` — Settings → Database → Connection string (URI), direct `5432`, add `?schema=saas`
   - `SUPABASE_URL`, `SUPABASE_ANON_KEY` — Settings → API
   - `SUPABASE_JWT_SECRET` — Settings → API → JWT Settings → JWT Secret
3. Install + generate:
   ```bash
   npm install
   npm run prisma:generate
   ```
4. Create the `saas` schema + tables (only touches `saas`, never `public`):
   ```bash
   npm run prisma:push
   ```
   > We use `db push` (not `migrate dev`) because a hosted Supabase DB usually
   > can't create the shadow database that `migrate dev` needs. `db push` creates
   > the `saas` schema and its tables directly and safely.
5. (optional) seed a first tenant: `npm run seed`
6. Run it: `npm run start:dev` → http://localhost:4000/api/v1/health

## Auth model
- The **frontend** signs users in with Supabase Auth and sends the access token as `Authorization: Bearer <token>`.
- `AuthGuard` verifies the token and upserts a local `users` row (linked by `supabase_user_id`).
- `TenantGuard` reads the `x-tenant-id` header and checks the user has an ACTIVE membership.
- `PermissionsGuard` + `@RequirePermissions(...)` enforce RBAC (role defaults in `src/auth/permissions.ts`).

## Endpoints (Phase 1)
| Method | Path | Guards |
|---|---|---|
| GET | `/api/v1/health` | public |
| GET | `/api/v1/me` | Auth |
| GET | `/api/v1/tenants` | Auth (my tenants) |
| POST | `/api/v1/tenants` | Auth (creator becomes OWNER) |
| GET | `/api/v1/tenants/current` | Auth + Tenant + Permission `customers.read` |

## Roadmap (PRD phases)
1. **Foundation** ✅ (this) — tenants, auth, RBAC, audit
2. Customers + Transactions ledger (status mapping, idempotency, imports base)
3. Intelligence — FTD, repeat deposits, Customer 360, rule versioning
4. Interakt WhatsApp — templates, queues, callbacks, retry
5. Company Intelligence — dashboard, P/L, Growth % / X
6. Financial Planning — allocation, budgets, targets
7. Reports & Data Ops — daily/weekly/monthly, exports, full import wizard
8. Hardening — reconciliation, load/security tests, backups
