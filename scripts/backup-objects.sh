#!/usr/bin/env bash
# PixelDuo object-storage backup (MinIO / S3 / Cloudflare R2 compatible).
#
# Mirrors the primary bucket (user images) into ./backups/objects/<stamp> and,
# when BACKUP_TARGET_* is set, to a second bucket for off-site DR. The compose
# `backup-objects` service runs this on a daily schedule; this script is the
# manual one-shot equivalent.
#
# Note: when run from the host, point BACKUP_S3_ENDPOINT at a host-reachable
# address (e.g. http://host.docker.internal:9000 on Docker Desktop).
#
# Usage: ./scripts/backup-objects.sh
set -euo pipefail

# Every user image and video, unencrypted, lands under ./backups/objects — and
# the tree was 0755 with 0644 files (measured), readable by any other account or
# process on the host. The host umask does NOT cross into the container that
# performs the mirror, so the mode is pinned there too (inside the `mc` script
# below) as well as here for anything this script itself creates.
umask 077

SRC_ENDPOINT="${BACKUP_S3_ENDPOINT:?set BACKUP_S3_ENDPOINT (source)}"
SRC_ACCESS="${BACKUP_S3_ACCESS_KEY_ID:?set BACKUP_S3_ACCESS_KEY_ID}"
SRC_SECRET="${BACKUP_S3_SECRET_ACCESS_KEY:?set BACKUP_S3_SECRET_ACCESS_KEY}"
SRC_BUCKET="${BACKUP_S3_BUCKET:?set BACKUP_S3_BUCKET}"
TARGET_ENDPOINT="${BACKUP_TARGET_ENDPOINT:-}"
TARGET_ACCESS="${BACKUP_TARGET_ACCESS_KEY_ID:-}"
TARGET_SECRET="${BACKUP_TARGET_SECRET_ACCESS_KEY:-}"
TARGET_BUCKET="${BACKUP_TARGET_BUCKET:-}"
# BACKUP_KEEP, not BACKUP_KEEP_OBJECTS — and .env.example documents the two as
# different knobs: BACKUP_KEEP is the DB-dump retention (the `backup` service,
# default 14) and BACKUP_KEEP_OBJECTS is the object-snapshot retention (default
# 7, what the `backup-objects` services pass in under the name BACKUP_KEEP
# *inside* the container). This script read the DB name (pass 33), so an
# operator who followed the documented flow — `set -a; source .env` then run
# this — had their object retention silently retuned to the dump's number, and
# a `BACKUP_KEEP_OBJECTS=30` (more snapshots wanted) was ignored: the rotation
# below kept 14 and `rm -rf`'d snapshots 15-30, backups they had explicitly
# asked to retain. KEEP still wins when set explicitly, so an existing runbook
# that passes it is unchanged.
KEEP="${KEEP:-${BACKUP_KEEP_OBJECTS:-7}}"

# Pinned by digest — the client both DR scripts depend on; see the
# note in docker-compose.yml. Override MC_IMAGE to bump it deliberately.
MC_IMAGE="${MC_IMAGE:-minio/mc@sha256:a7fe349ef4bd8521fb8497f55c6042871b2ae640607cf99d9bede5e9bdf11727}"

# Credentials travel via the CHILD ENVIRONMENT, never the argv: `docker run -e
# VAR=value` writes the value into this command's argv, which /proc exposes to
# every account on the host (`ps -ww`) for as long as the mirror runs — same
# class this script already pins file modes for. `-e VAR` (no `=value`) takes
# the value from this shell's environment, so export first.
export SRC_ENDPOINT SRC_ACCESS SRC_SECRET SRC_BUCKET
export TARGET_ENDPOINT TARGET_ACCESS TARGET_SECRET TARGET_BUCKET KEEP
docker run --rm \
  --entrypoint /bin/sh \
  -e SRC_ENDPOINT \
  -e SRC_ACCESS \
  -e SRC_SECRET \
  -e SRC_BUCKET \
  -e TARGET_ENDPOINT \
  -e TARGET_ACCESS \
  -e TARGET_SECRET \
  -e TARGET_BUCKET \
  -e KEEP \
  -v "$PWD/backups:/backups" \
  "$MC_IMAGE" -c '
    set -e
    umask 077
    mc alias set src "$SRC_ENDPOINT" "$SRC_ACCESS" "$SRC_SECRET" >/dev/null
    STAMP=$(date +%Y%m%d-%H%M%S)
    rm -rf /backups/objects/.*.partial
    mc mirror --overwrite --remove "src/$SRC_BUCKET" "/backups/objects/.$STAMP.partial"
    mv "/backups/objects/.$STAMP.partial" "/backups/objects/$STAMP"
    ls -1t /backups/objects/ | tail -n +$((KEEP + 1)) | while read -r f; do rm -rf "/backups/objects/$f"; done
    echo "[backup-objects] $STAMP mirrored from $SRC_BUCKET (keeping $KEEP snapshots)"
    if [ -n "$TARGET_ENDPOINT" ]; then
      mc alias set tgt "$TARGET_ENDPOINT" "$TARGET_ACCESS" "$TARGET_SECRET" >/dev/null
      mc mirror --overwrite --remove "src/$SRC_BUCKET" "tgt/$TARGET_BUCKET"
      echo "[backup-objects] off-site mirror to $TARGET_BUCKET done"
    fi
  '
