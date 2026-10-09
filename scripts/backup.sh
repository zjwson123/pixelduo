#!/usr/bin/env bash
# PixelDuo database backup (Postgres container) with rotation.
# Usage: ./scripts/backup.sh [container] [database]
set -euo pipefail

# The dump is a complete copy of the database — every email, bcrypt hash, order,
# ledger row and payment payload — and it was written 0644 into a 0755 directory
# (measured on this host: -rw-r--r-- backups/*.dump.gz, drwxr-xr-x backups/),
# i.e. readable by every other account and every other process on the machine.
# Nothing in the backup path had ever pinned a mode, while setup-mail.ts already
# writes its .env 0600 — this is the same rule applied to the bigger secret. The
# compose backup loops pin the container side the same way.
umask 077

CONTAINER="${1:-}"
DB="${2:-${PGDATABASE:-pixelduo}}"
DB_USER="${DB_USER:-${POSTGRES_USER:-pixelduo}}"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_DIR="${BACKUP_DIR:-backups}"
# BACKUP_KEEP is the name .env.example and the compose `backup` service use
# (scripts/backup-objects.sh reads it too). This script read only KEEP, so an
# operator who sourced the documented env file and set BACKUP_KEEP=30 got 14
# from the manual dump and 30 from the service — two retention numbers, one
# documented, one silent (pass 32). KEEP still wins when set explicitly, so
# existing runbooks are unchanged.
KEEP="${KEEP:-${BACKUP_KEEP:-14}}"

# A container named `pixelduo-db` exists only in the DEV compose (it pins
# container_name); the single-VPS stack leaves Compose to name it
# `<project>-db-1`, so the manual dump the README and docs/deploy.md document
# died with "No such container" on exactly the deployment whose runbook points
# here (pass 31 — loudly, so nothing was lost, but during an incident). The
# DEFAULT therefore resolves by the compose service LABEL, which is independent
# of project directory and file name, and SAYS which container it picked. An
# explicitly passed name is used as given — a typo must fail loudly rather than
# silently dump a different database (the pass-25 assertion that a bad
# container is a nonzero exit pins exactly that). The role comes from
# POSTGRES_USER for the same reason (.env.example advises changing the default
# and the compose file makes it configurable) — a hardcoded `-U pixelduo` fails
# on a stack that followed that advice.
if [ -z "$CONTAINER" ]; then
  CONTAINER="${DB_CONTAINER:-pixelduo-db}"
  if ! docker inspect "$CONTAINER" >/dev/null 2>&1; then
    FOUND="$(docker ps --filter label=com.docker.compose.service=db --format '{{.Names}}' | head -n1)"
    if [ -n "$FOUND" ]; then
      echo "[backup] no container '$CONTAINER' — using '$FOUND' (the running compose 'db' service)" >&2
      CONTAINER="$FOUND"
    else
      echo "[backup] no container '$CONTAINER' and no running compose 'db' service — pass one explicitly: ./scripts/backup.sh <container> [database]" >&2
      exit 1
    fi
  fi
fi

mkdir -p "$BACKUP_DIR"
OUT="$BACKUP_DIR/${DB}-${STAMP}.sql.gz"
TMP="$BACKUP_DIR/.${DB}-${STAMP}.partial"

# A failed dump must take its partial file with it. Without this, any failure
# between the redirect below and the rename (a stopped container, a lock
# timeout, a full disk) aborts on `set -e`/pipefail and leaves a full-database-
# sized HIDDEN file behind: the retention glob, `ls backups/*.dump.gz` and every
# monitoring check ignore dotfiles, so nothing ever removes it — and a directory
# that keeps filling is what causes the next failure. The compose loops already
# delete their partials on the failure path; this is the same guarantee for the
# host script, which cannot fail-write a partial at all now.
trap 'rm -f "$TMP"' EXIT

# Partials from earlier runs (before the trap, or from a killed shell) are
# invisible to the rotation above and accumulate for ever. Purge them here,
# where the directory is already being touched.
find "$BACKUP_DIR" -maxdepth 1 -name ".*.partial" -type f -mtime +1 -delete 2>/dev/null || true

# Write through a partial name and rename on success. `docker exec pg_dump | gzip
# > $OUT` left a truncated file under the FINAL name whenever the dump failed
# (a stopped container, a bad password, a full disk), and the extension is what
# the restore instructions and the rotation glob both key on — an operator
# restoring that file gets a half database and no warning. `set -o pipefail`
# makes the failure loud, but only the rename can keep the directory honest.
docker exec "$CONTAINER" pg_dump -U "$DB_USER" -d "$DB" | gzip > "$TMP"
mv "$TMP" "$OUT"
echo "backup written: $OUT ($(du -h "$OUT" | cut -f1))"

# Rotate old backups
ls -1t "$BACKUP_DIR"/"${DB}"-*.sql.gz 2>/dev/null | tail -n +$((KEEP + 1)) | while read -r old; do
  rm -f "$old"
  echo "removed old backup: $old"
done

echo "restore: gunzip -c $OUT | docker exec -i $CONTAINER psql -U $DB_USER -d $DB"
