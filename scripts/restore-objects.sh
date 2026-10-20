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
#
# DRY RUN BY DEFAULT. The mirror runs with --remove, so it deletes every object
# in the target that the snapshot does not contain; the target is whatever this
# argument names. The header warning ("never restore over the live bucket") was
# the only guard, and the live bucket is the one name an operator under incident
# pressure actually knows — `BACKUP_S3_BUCKET`/`S3_BUCKET` in every doc and
# compose file. Naming it would have deleted every image uploaded since the
# snapshot was taken. So: the target is checked against the known bucket names
# below, and the real mirror needs RESTORE_DRILL_CONFIRM=1; without it the
# script prints exactly what it would do and exits non-zero.
set -euo pipefail

STAMP="${1:?usage: ./scripts/restore-objects.sh <stamp> <scratch-bucket>}"
SCRATCH_BUCKET="${2:?usage: ./scripts/restore-objects.sh <stamp> <scratch-bucket>}"
SRC_ENDPOINT="${BACKUP_S3_ENDPOINT:?set BACKUP_S3_ENDPOINT (target of restore)}"
SRC_ACCESS="${BACKUP_S3_ACCESS_KEY_ID:?set BACKUP_S3_ACCESS_KEY_ID}"
SRC_SECRET="${BACKUP_S3_SECRET_ACCESS_KEY:?set BACKUP_S3_SECRET_ACCESS_KEY}"
# Pinned by digest — the client both DR scripts depend on; see the
# note in docker-compose.yml. Override MC_IMAGE to bump it deliberately.
MC_IMAGE="${MC_IMAGE:-minio/mc@sha256:a7fe349ef4bd8521fb8497f55c6042871b2ae640607cf99d9bede5e9bdf11727}"

# The target must be a BARE bucket name before anything compares it.
#
# The loop below is whole-string equality, but `mc` parses its argument as
# `alias/bucket/prefix`: "pixelduo/" IS the live bucket to mc and a different
# string to `[ = ]`. A trailing slash — the standard copy-paste artefact of
# half a URL, and the shape the pass-36 finding fixed elsewhere in this tree —
# therefore walked past every arm and the drill mirrored WITH --remove into the
# live bucket: every object uploaded after the snapshot deleted, and
# "RESTORE DRILL PASSED" printed, because the restored count still matched the
# snapshot (probed in pass 37 on a scratch bucket holding one post-snapshot
# upload). The same applies to `<live>/<suffix>`. Only the bare-name form can
# be compared, so anything else is refused outright rather than normalized —
# the operator who typed the slash meant a bucket, and guessing which one is
# the whole hazard.
case "$SCRATCH_BUCKET" in
  ""|*/*|*[!A-Za-z0-9._-]*)
    echo "refusing '$SCRATCH_BUCKET': the target must be a bare bucket name (letters, digits, '.', '_', '-'), with no '/'. mc reads its argument as 'alias/bucket/prefix', so any slash aims somewhere this script cannot compare against the live-bucket list." >&2
    exit 1
    ;;
esac

# Anything that names real data. A drill into one of these destroys it and is
# never what the operator meant — refuse rather than ask.
#
# The literal 'pixelduo' is the name the compose files PIN (`S3_BUCKET:
# pixelduo` — docker-compose.single.yml:43, docker-compose.prod.yml), and it
# was exactly the name the env-derived arms below could not see: the documented
# single-VPS drill sources `.env.example`, which ships `S3_BUCKET=""` and does
# not mention BACKUP_S3_BUCKET/BACKUP_TARGET_BUCKET at all — so on the one
# deployment whose live bucket is a pinned literal, all three arms were empty
# and `RESTORE_DRILL_CONFIRM=1 ./scripts/restore-objects.sh <stamp> pixelduo`
# proceeded to `mc mirror --overwrite --remove` into the live bucket (measured
# with the drill's own dry run in pass 30). A scratch bucket never has to be
# named this, so the refusal is free.
for forbidden in pixelduo "${BACKUP_S3_BUCKET:-}" "${S3_BUCKET:-}" "${BACKUP_TARGET_BUCKET:-}"; do
  if [ -n "$forbidden" ] && [ "$SCRATCH_BUCKET" = "$forbidden" ]; then
    echo "refusing to restore into '$SCRATCH_BUCKET': that is a live bucket (the compose-pinned 'pixelduo', BACKUP_S3_BUCKET, S3_BUCKET or BACKUP_TARGET_BUCKET)." >&2
    echo "This drill mirrors with --remove, so it would delete every object uploaded since the snapshot." >&2
    echo "Name a scratch bucket that does not exist yet." >&2
    exit 1
  fi
done

# A stamp is a snapshot NAME, not a path. `..`, `../..` or an absolute value
# resolved through $PWD would mount (and mirror) the repo root or anything else
# into the target bucket — the same argv-boundary rule the target name gets.
case "$STAMP" in
  [0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]-[0-9][0-9][0-9][0-9][0-9][0-9]) ;;
  *)
    echo "refusing stamp '$STAMP': expected YYYYMMDD-HHMMSS" >&2
    exit 1
    ;;
esac

SNAPSHOT="$PWD/backups/objects/$STAMP"
[ -d "$SNAPSHOT" ] || { echo "snapshot not found: $SNAPSHOT"; exit 1; }

SRC_COUNT=$(find "$SNAPSHOT" -type f | wc -l | tr -d " ")
# An empty snapshot is what a failed/emptied-source backup used to leave behind
# (and its drill then "passed" by mirroring 0 objects and comparing 0 == 0).
# A real drill needs objects; forcing an empty one is an explicit opt-in.
if [ "$SRC_COUNT" -eq 0 ] && [ "${RESTORE_DRILL_ALLOW_EMPTY:-0}" != "1" ]; then
  echo "refusing an EMPTY snapshot ($SNAPSHOT): restore drill would prove nothing. Set RESTORE_DRILL_ALLOW_EMPTY=1 if this is intentional." >&2
  exit 1
fi

if [ "${RESTORE_DRILL_CONFIRM:-0}" != "1" ]; then
  echo "DRY RUN (nothing written). This would mirror $SRC_COUNT object(s) from"
  echo "  snapshot: $SNAPSHOT"
  echo "  into:     $SRC_ENDPOINT/$SCRATCH_BUCKET"
  echo "with --overwrite --remove, i.e. deleting anything already in that bucket."
  echo "Re-run with RESTORE_DRILL_CONFIRM=1 once the target is right."
  exit 1
fi

# Same argv rule as scripts/backup-objects.sh: the bucket credentials go in
# through the child environment (`-e VAR` with the value exported), never as
# `-e VAR=value` in an argv every local account can read with `ps -ww`.
export SRC_ENDPOINT SRC_ACCESS SRC_SECRET
docker run --rm \
  --entrypoint /bin/sh \
  -e SRC_ENDPOINT \
  -e SRC_ACCESS \
  -e SRC_SECRET \
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
