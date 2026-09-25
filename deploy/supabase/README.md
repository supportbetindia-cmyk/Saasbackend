# Self-hosted Supabase for BetIndia

Run Supabase (Postgres + Auth + PostgREST) **on your own VPS, next to the NestJS
backend**, instead of managed Supabase in the cloud. Your app code does **not**
change — same `/rest/v1/` and `/auth/v1/` — you only repoint `SUPABASE_URL` and
swap the keys. Because the database is now on the same machine as the backend,
DB round-trips drop from ~250 ms (EU↔Seoul) to ~sub-millisecond (localhost).

**What you gain:** no Supabase bill, lowest possible latency, full control.
**What you take on:** you now operate the stack — Docker upgrades, **backups**,
and the box dying = the DB dying (so keep offsite backups).

---

## Files in this folder

| File | What it does |
|---|---|
| `gen-keys.mjs` | Generates `JWT_SECRET` + matching `ANON_KEY` / `SERVICE_ROLE_KEY`. Run once. |
| `env.betindia.example` | The handful of `.env` values that differ from Supabase defaults for our app. |
| `Caddyfile` | HTTPS reverse proxy in front of Kong (auto Let's Encrypt certs). |
| `migrate-from-cloud.sh` | One-time data copy from cloud Supabase → self-hosted. |
| `backup.sh` | Nightly `pg_dump` + prune. Put it in cron. |

This folder does **not** ship the Supabase `docker-compose.yml` itself — that file
is large, versioned, and maintained upstream. You clone the official one (step 2)
so you always get a known-good, current stack, then layer our values on top.

---

## VPS sizing
The full Supabase stack is heavier than a bare Node app. Plan for **4 GB RAM**
(8 GB if you also build the frontend on the same box). 2 GB is not enough for the
full stack. Ubuntu 24.04, Docker + Docker Compose installed.

---

## Setup, start to finish

### 1. Install Docker (on the VPS)
```bash
curl -fsSL https://get.docker.com | sh
```

### 2. Get the official Supabase compose
```bash
git clone --depth 1 https://github.com/supabase/supabase ~/supabase-src && cp -r ~/supabase-src/docker ~/betindia-supabase && cd ~/betindia-supabase && cp .env.example .env
```

### 3. Generate secrets
Copy `gen-keys.mjs` to the VPS (or run it locally) and run:
```bash
node gen-keys.mjs
```
Paste the printed `POSTGRES_PASSWORD`, `JWT_SECRET`, `ANON_KEY`, `SERVICE_ROLE_KEY`
into `~/betindia-supabase/.env`, replacing the defaults. Then merge the rest of the
values from `env.betindia.example` (URLs, autoconfirm, schemas) into the same `.env`.
Keep the three `# ---- app env ----` lines — you need them in step 8.

### 4. Start the stack
```bash
docker compose up -d
```
Wait ~30 s, then confirm everything is healthy:
```bash
docker compose ps
```
Kong now serves the unified API on **port 8000**. Smoke-test PostgREST + Auth:
```bash
curl -s http://localhost:8000/auth/v1/health -H "apikey: $SERVICE_ROLE_KEY"
```

> **Trimming (optional, do later):** to save RAM you can stop services you don't
> use — `storage`, `imgproxy`, `realtime`, `functions`. Do this only after the
> full stack works, and mind that newer compose files wire some services to
> `analytics`/`vector` via `depends_on`; remove those references before stopping
> them. Not required — a 4 GB box runs the whole thing fine.

### 5. Migrate your data from cloud Supabase
```bash
CLOUD_DB_URL="postgresql://postgres:PWD@db.YOURPROJECT.supabase.co:5432/postgres" ./migrate-from-cloud.sh
```
(Direct connection string, port 5432 — from cloud dashboard → Settings → Database.)
This restores `public`, `saas`, and `auth`. **Test a login before cutover** — if
GoTrue rejects the restored `auth` schema, the script prints the data-only fallback.

### 6. Point DNS
Add an `A` record `api.betindia.games` → your VPS IP.

### 7. HTTPS in front of Kong
```bash
sudo caddy run --config ./Caddyfile
```
(Or install Caddy as a systemd service and put the `Caddyfile` in `/etc/caddy/`.)
`https://api.betindia.games` is now your Supabase base URL.

### 8. Repoint the app (the only "code" change — it's just env)
Set these on **both** the backend and the frontend host, then redeploy both:
```
SUPABASE_URL=https://api.betindia.games
NEXT_PUBLIC_SUPABASE_URL=https://api.betindia.games
NEXT_PUBLIC_SUPABASE_ANON_KEY=<ANON_KEY from step 3>
SUPABASE_SERVICE_ROLE_KEY=<SERVICE_ROLE_KEY from step 3>
SUPABASE_JWT_SECRET=<JWT_SECRET from step 3>
```
And point the backend's Prisma at the local Postgres (saas schema access):
```
DATABASE_URL=postgresql://postgres:<POSTGRES_PASSWORD>@localhost:5432/postgres?schema=saas
```
> Our backend `jwt.util.ts` already supports HS256 verification via
> `SUPABASE_JWT_SECRET`, which is exactly how self-hosted GoTrue signs tokens —
> so login verification keeps working with no code change.

### 9. Turn on backups (don't skip)
```bash
crontab -e
```
Add:
```
30 2 * * *  /home/YOU/betindia-supabase/deploy/backup.sh >> /var/log/betindia-backup.log 2>&1
```
Then set up an offsite copy (rclone → Backblaze B2 / R2 / S3) — see the commented
line in `backup.sh`. Also take a VPS snapshot from your provider weekly.

---

## Cutover checklist
- [ ] `docker compose ps` all healthy
- [ ] `/auth/v1/health` returns ok over HTTPS
- [ ] Data migrated; row counts match cloud (`select count(*) from saas.transactions;`)
- [ ] A test login succeeds against the new stack
- [ ] App env repointed on backend **and** frontend; both redeployed
- [ ] Transactions page loads per-company data (proves REST + backend both work)
- [ ] Nightly backup cron installed + one manual `./backup.sh` run verified
- [ ] Offsite backup sync configured

## Gotchas
- **Single backend instance only** — the 2-minute LiveSync loop double-imports if
  two copies run. One PM2 process, not cluster mode.
- **Keys must match** — `ANON_KEY`/`SERVICE_ROLE_KEY` are only valid if signed with
  the same `JWT_SECRET` the containers use. Always regenerate all three together.
- **Latency win is real only if co-located** — keep Supabase and the backend on the
  same VPS (or same private network). Splitting them across regions re-adds the hop.
- **Don't expose Studio** publicly — it's admin access to everything. Reach it via
  SSH tunnel: `ssh -L 3000:localhost:3000 vps`.
