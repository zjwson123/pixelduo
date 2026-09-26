#!/usr/bin/env bash
# PixelDuo object-storage restore drill.
#
# Mirrors a local snapshot (./backups/objects/<stamp>) into a scratch bucket and
# verifies the object COUNT matches the source snapshot. Use a scratch bucket —
# never restore over the live bucket from a drill.
#
# It does NOT compare checksums, and the header used to say it did: `mc find`
# lists names, so a drill proves the objects were copied under the same keys and
# nothing about their contents. (On some mc versions it also counts the
# directory entries, which makes the comparison pass or fail for reasons that
# have nothing to do with the data — read the two numbers, not just the verdict.)
# A real content check means `mc cat`/`mc stat` per key or a companion manifest
# of sizes/hashes written by scripts/backup-objects.sh; until then, treat a PASS
# as "the snapshot is readable and complete in shape", and restore a few objects
# by hand when the drill matters.
#
# Usage: ./scripts/restore-objects.sh <stamp> <scratch-bucket>
set -euo pipefail

STAMP="${1:?usage: ./scripts/restore-objects.sh <stamp> <scratch-bucket>}"
SCRATCH_BUCKET="${2:?usage: ./scripts/restore-objects.sh <stamp> <scratch-bucket>}"
SRC_ENDPOINT="${BACKUP_S3_ENDPOINT:?set BACKUP_S3_ENDPOINT (target of restore)}"
SRC_ACCESS="${BACKUP_S3_ACCESS_KEY_ID:?set BACKUP_S3_ACCESS_KEY_ID}"
SRC_SECRET="${BACKUP_S3_SECRET_ACCESS_KEY:?set BACKUP_S3_SECRET_ACCESS_KEY}"
MC_IMAGE="${MC_IMAGE:-minio/mc:latest}"

SNAPSHOT="$PWD/backups/objects/$STAMP"
[ -d "$SNAPSHOT" ] || { echo "snapshot not found: $SNAPSHOT"; exit 1; }

SRC_COUNT=$(find "$SNAPSHOT" -type f | wc -l | tr -d " ")

docker run --rm \
  --entrypoint /bin/sh \
  -e SRC_ENDPOINT="$SRC_ENDPOINT" \
  -e SRC_ACCESS="$SRC_ACCESS" \
  -e SRC_SECRET="$SRC_SECRET" \
  -e SCRATCH_BUCKET="$SCRATCH_BUCKET" \
  -e SRC_COUNT="$SRC_COUNT" \
  -v "$SNAPSHOT:/snapshot:ro" \
  "$MC_IMAGE" -c '
    set -e
    mc alias set tgt "$SRC_ENDPOINT" "$SRC_ACCESS" "$SRC_SECRET" >/dev/null
    mc mb -p "tgt/$SCRATCH_BUCKET" >/dev/null 2>&1 || true
    mc mirror --overwrite --remove "/snapshot" "tgt/$SCRATCH_BUCKET"
    RESTORED=$(mc find "tgt/$SCRATCH_BUCKET" 2>/dev/null | wc -l | tr -d " ")
    echo "restored $RESTORED objects to scratch bucket $SCRATCH_BUCKET (source: $SRC_COUNT)"
    [ "$RESTORED" = "$SRC_COUNT" ] || { echo "RESTORE DRILL FAILED: count mismatch"; exit 1; }
    echo "RESTORE DRILL PASSED"
  '
