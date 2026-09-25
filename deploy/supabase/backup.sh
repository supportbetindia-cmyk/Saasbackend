#!/usr/bin/env bash
# Nightly logical backup of the self-hosted Supabase database.
# Managed Supabase did this for you; now you own it. Runs a full pg_dump,
# gzips it, and prunes anything older than 14 days.
#
# Install as a cron job (runs 02:30 daily):
#   crontab -e
#   30 2 * * *  /home/USER/betindia/deploy/supabase/backup.sh >> /var/log/betindia-backup.log 2>&1
#
# STRONGLY recommended: after the dump, sync BACKUP_DIR to offsite object
# storage (Backblaze B2 / Cloudflare R2 / S3) with rclone — a backup that
# only lives on the same VPS dies with the VPS.
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/var/backups/betindia}"
KEEP_DAYS="${KEEP_DAYS:-14}"
# Run from the folder holding docker-compose.yml so `docker compose` resolves.
cd "$(dirname "$0")"

mkdir -p "$BACKUP_DIR"
OUT="$BACKUP_DIR/betindia-$(date +%F-%H%M).sql.gz"

echo ">> Dumping to $OUT"
docker compose exec -T db pg_dump -U postgres postgres | gzip > "$OUT"

echo ">> Pruning backups older than ${KEEP_DAYS} days"
find "$BACKUP_DIR" -name 'betindia-*.sql.gz' -mtime "+${KEEP_DAYS}" -delete

# Example offsite sync (uncomment after `rclone config` sets up a remote named b2):
# rclone copy "$OUT" b2:betindia-backups/

echo ">> Backup complete"
