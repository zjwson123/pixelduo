#!/usr/bin/env bash
# PixelDuo database backup (Postgres container) with rotation.
# Usage: ./scripts/backup.sh [container] [database]
set -euo pipefail

CONTAINER="${1:-pixelduo-db}"
DB="${2:-pixelduo}"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_DIR="${BACKUP_DIR:-backups}"
KEEP="${KEEP:-14}"

mkdir -p "$BACKUP_DIR"
OUT="$BACKUP_DIR/${DB}-${STAMP}.sql.gz"

docker exec "$CONTAINER" pg_dump -U pixelduo -d "$DB" | gzip > "$OUT"
echo "backup written: $OUT ($(du -h "$OUT" | cut -f1))"

# Rotate old backups
ls -1t "$BACKUP_DIR"/"${DB}"-*.sql.gz 2>/dev/null | tail -n +$((KEEP + 1)) | while read -r old; do
  rm -f "$old"
  echo "removed old backup: $old"
done

echo "restore: gunzip -c $OUT | docker exec -i $CONTAINER psql -U pixelduo -d $DB"
