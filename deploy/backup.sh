#!/bin/sh
# Nightly backup of the SQLite database using SQLite's own online backup (safe while the app runs).
# Cron: 0 2 * * * /opt/sourcing-crm/deploy/backup.sh
set -eu
DB="${DB_FILE:-/var/lib/sourcing-crm/crm.db}"
OUT="${BACKUP_DIR:-/var/backups/sourcing-crm}"
mkdir -p "$OUT"
STAMP=$(date +%Y%m%d-%H%M)
sqlite3 "$DB" ".backup '$OUT/crm-$STAMP.db'"
gzip "$OUT/crm-$STAMP.db"
# Keep 30 days
find "$OUT" -name 'crm-*.db.gz' -mtime +30 -delete
echo "backed up to $OUT/crm-$STAMP.db.gz"
