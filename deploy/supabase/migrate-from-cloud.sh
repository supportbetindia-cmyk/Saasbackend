#!/usr/bin/env bash
# One-time: copy data from managed (cloud) Supabase into the self-hosted stack.
#
# Dumps public + saas (your data) and auth (so existing logins keep working),
# then restores into the `db` container.
#
# Usage:
#   CLOUD_DB_URL="postgresql://postgres:PWD@db.YOURPROJECT.supabase.co:5432/postgres" \
#   ./migrate-from-cloud.sh
#
# Get CLOUD_DB_URL from: cloud Supabase dashboard -> Project Settings -> Database ->
# Connection string (URI). Use the DIRECT connection (port 5432), not the pooler.
set -euo pipefail

: "${CLOUD_DB_URL:?Set CLOUD_DB_URL to your cloud Supabase connection string}"
DUMP="cloud-dump-$(date +%F).sql"

echo ">> Dumping public + saas + auth from cloud..."
pg_dump "$CLOUD_DB_URL" \
  --schema=public --schema=saas --schema=auth \
  --no-owner --no-privileges \
  -f "$DUMP"

echo ">> Restoring into the self-hosted db container..."
# `db` is the compose service name; postgres is the default db + superuser.
docker compose exec -T db psql -U postgres -d postgres < "$DUMP"

echo ">> Done. Dump kept at $DUMP"
echo ">> IMPORTANT: test a login before cutover. If GoTrue rejects the restored"
echo "   auth schema (version mismatch), restore ONLY the data rows instead:"
echo "     pg_dump \"\$CLOUD_DB_URL\" --data-only --table=auth.users --table=auth.identities -f auth-data.sql"
echo "     docker compose exec -T db psql -U postgres -d postgres < auth-data.sql"
