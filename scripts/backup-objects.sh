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

SRC_ENDPOINT="${BACKUP_S3_ENDPOINT:?set BACKUP_S3_ENDPOINT (source)}"
SRC_ACCESS="${BACKUP_S3_ACCESS_KEY_ID:?set BACKUP_S3_ACCESS_KEY_ID}"
SRC_SECRET="${BACKUP_S3_SECRET_ACCESS_KEY:?set BACKUP_S3_SECRET_ACCESS_KEY}"
SRC_BUCKET="${BACKUP_S3_BUCKET:?set BACKUP_S3_BUCKET}"
TARGET_ENDPOINT="${BACKUP_TARGET_ENDPOINT:-}"
TARGET_ACCESS="${BACKUP_TARGET_ACCESS_KEY_ID:-}"
TARGET_SECRET="${BACKUP_TARGET_SECRET_ACCESS_KEY:-}"
TARGET_BUCKET="${BACKUP_TARGET_BUCKET:-}"
KEEP="${BACKUP_KEEP:-7}"

MC_IMAGE="${MC_IMAGE:-minio/mc:latest}"

docker run --rm \
  --entrypoint /bin/sh \
  -e SRC_ENDPOINT="$SRC_ENDPOINT" \
  -e SRC_ACCESS="$SRC_ACCESS" \
  -e SRC_SECRET="$SRC_SECRET" \
  -e SRC_BUCKET="$SRC_BUCKET" \
  -e TARGET_ENDPOINT="$TARGET_ENDPOINT" \
  -e TARGET_ACCESS="$TARGET_ACCESS" \
  -e TARGET_SECRET="$TARGET_SECRET" \
  -e TARGET_BUCKET="$TARGET_BUCKET" \
  -e KEEP="$KEEP" \
  -v "$PWD/backups:/backups" \
  "$MC_IMAGE" -c '
    set -e
    mc alias set src "$SRC_ENDPOINT" "$SRC_ACCESS" "$SRC_SECRET" >/dev/null
    STAMP=$(date +%Y%m%d-%H%M%S)
    mc mirror --overwrite --remove "src/$SRC_BUCKET" "/backups/objects/$STAMP"
    ls -1t /backups/objects/ | tail -n +$((KEEP + 1)) | while read -r f; do rm -rf "/backups/objects/$f"; done
    echo "[backup-objects] $STAMP mirrored from $SRC_BUCKET (keeping $KEEP snapshots)"
    if [ -n "$TARGET_ENDPOINT" ]; then
      mc alias set tgt "$TARGET_ENDPOINT" "$TARGET_ACCESS" "$TARGET_SECRET" >/dev/null
      mc mirror --overwrite --remove "src/$SRC_BUCKET" "tgt/$TARGET_BUCKET"
      echo "[backup-objects] off-site mirror to $TARGET_BUCKET done"
    fi
  '
