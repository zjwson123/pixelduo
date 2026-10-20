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
# BACKUP_KEEP is the name .env.example and the compose `backup` service use.
# This script read only KEEP, so an operator who sourced the documented env
# file and set BACKUP_KEEP=30 got 14 from the manual dump and 30 from the
# service — two retention numbers, one documented, one silent (pass 32). The
# object script has its own documented knob (BACKUP_KEEP_OBJECTS, default 7),
# which until pass 33 it read as THIS one — its rotation deleted snapshots the
# operator had asked to keep. The two scripts must not share a name they do not
# share a meaning with. KEEP still wins when set explicitly, so existing
# runbooks are unchanged.
KEEP="${KEEP:-${BACKUP_KEEP:-14}}"

# A rotation must never delete the snapshot it just wrote, and `tail -n +N` with
# N = KEEP + 1 = 1 prints EVERY line: KEEP=0 — the natural spelling of "no
# retention", and what a whitespace-only value also collapses to — removed the
# just-renamed dump together with the older ones and then printed the success
# line, so the deployment kept ZERO backups while every log affirmed one
# (probed in pass 37 through this rotation verbatim: 4 files in, 0 out, the
# newest among the deletions). "Keep none" is not a meaningful policy for a
# backup service, so a numeric 0 is clamped to 1 and the newest always
# survives. A non-numeric value is refused rather than clamped: `$((KEEP + 1))`
# already dies on a typo, and silently retuning a typo'd `BACKUP_KEEP=1O` to 1
# would delete the thirteen dumps the operator meant to keep — the same class
# pass 33 fixed in the other direction.
case "$KEEP" in
  ''|*[!0-9]*)
    echo "KEEP/BACKUP_KEEP must be a non-negative integer (got '$KEEP')" >&2
    exit 1
    ;;
esac
[ "$KEEP" -ge 1 ] || KEEP=1

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
  if [ -n "${DB_CONTAINER:-}" ]; then
    CONTAINER="$DB_CONTAINER"
    echo "[backup] using DB_CONTAINER='$CONTAINER'" >&2
  else
    # NO default container name. The dev compose pins `pixelduo-db`; a host
    # that also runs the single-VPS stack therefore used to find it silently,
    # dump the DEV database into the production checkout's backups/ dir, print
    # success and rotate the oldest PRODUCTION dumps out. Exactly one running
    # compose db service is the only unambiguous answer; anything else is the
    # operator's to name.
    FOUND="$(docker ps --filter label=com.docker.compose.service=db --format '{{.Names}}')"
    COUNT="$(printf '%s\n' "$FOUND" | sed '/^$/d' | wc -l | tr -d ' ')"
    if [ "$COUNT" -ne 1 ]; then
      echo "[backup] expected exactly one running compose 'db' service, found $COUNT:" >&2
      printf '%s\n' "$FOUND" | sed '/^$/d' | sed 's/^/  /' >&2
      echo "[backup] pass the intended container explicitly: ./scripts/backup.sh <container> [database]" >&2
      exit 1
    fi
    CONTAINER="$(printf '%s\n' "$FOUND" | sed '/^$/d' | head -n1)"
    echo "[backup] using '$CONTAINER' (the only running compose 'db' service)" >&2
  fi
  if ! docker inspect "$CONTAINER" >/dev/null 2>&1; then
    echo "[backup] container '$CONTAINER' does not exist — pass the intended container explicitly: ./scripts/backup.sh <container> [database]" >&2
    exit 1
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
# A dump that is valid gzip but empty is not a backup. `pg_dump` of a dropped
# or wrong database can exit 0 with a header-only stream; rotating that in and
# deleting yesterday's complete dump is the same destructive pattern the object
# backup guards against. 1 KiB is below any real schema-only dump.
gzip -t "$TMP"
BYTES="$(wc -c < "$TMP" | tr -d ' ')"
if [ "$BYTES" -lt 1024 ]; then
  echo "[backup] refusing a $BYTES-byte dump from '$CONTAINER' database '$DB' — is this the right container/database? The previous dumps were left untouched." >&2
  exit 1
fi
mv "$TMP" "$OUT"
echo "backup written: $OUT ($(du -h "$OUT" | cut -f1))"

# Rotate old backups
ls -1t "$BACKUP_DIR"/"${DB}"-*.sql.gz 2>/dev/null | tail -n +$((KEEP + 1)) | while read -r old; do
  rm -f "$old"
  echo "removed old backup: $old"
done

echo "restore: gunzip -c $OUT | docker exec -i $CONTAINER psql -U $DB_USER -d $DB"
