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

# An off-site target is all-or-nothing, and the bucket must be a real bucket
# name. `mc mirror tgt//$STAMP` with an empty bucket creates a bucket NAMED
# AFTER THE TIMESTAMP on the remote store, and the stamp rotation below would
# then delete timestamp-named buckets — creating and destroying buckets on a
# remote store from a typo. The restore script already validates its target;
# this side must too. Refuse before taking a snapshot, not halfway through.
if [ -n "$TARGET_ENDPOINT" ]; then
  case "$TARGET_BUCKET" in
    ""|[!a-z0-9]*|*[!a-z0-9.-]*)
      echo "BACKUP_TARGET_BUCKET must be a valid S3 bucket name (lowercase letters, digits, dots, hyphens; got '$TARGET_BUCKET')" >&2
      exit 1
      ;;
  esac
  if [ -z "$TARGET_ACCESS" ] || [ -z "$TARGET_SECRET" ]; then
    echo "set BACKUP_TARGET_ACCESS_KEY_ID and BACKUP_TARGET_SECRET_ACCESS_KEY when BACKUP_TARGET_ENDPOINT is set" >&2
    exit 1
  fi
fi
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

# Same clamp as scripts/backup.sh, for the same probed failure: `tail -n +N`
# with N = KEEP + 1 = 1 prints every line, so KEEP=0 rotated away the snapshot
# this run had just renamed into place and still reported success ("keeping 0"
# after deleting all of them). A numeric 0 becomes 1 — the newest snapshot is
# never the thing retention deletes — while a non-numeric value is refused
# rather than clamped, so a typo cannot quietly retune a retention the operator
# set high.
case "$KEEP" in
  ''|*[!0-9]*)
    echo "KEEP/BACKUP_KEEP_OBJECTS must be a non-negative integer (got '$KEEP')" >&2
    exit 1
    ;;
esac
[ "$KEEP" -ge 1 ] || KEEP=1

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
# Create the mount source as the invoking user before Docker sees it. If the
# directory is missing, Docker creates it owned by root and the container
# (now uid $(id -u)) cannot write into it — the same failure the compose
# services document. mkdir here makes the owner the operator who ran this.
# Refuse a symlinked mount source first: the chmod/recursive sweep below would
# otherwise act on whatever it points at, and the container mount would follow
# it too. Same rule pass 61 applied to the /tmp log paths.
if [ -L "$PWD/backups" ] || [ -L "$PWD/backups/objects" ]; then
  echo "[backup-objects] backups/ or backups/objects is a symlink — refusing to write through it" >&2
  exit 1
fi
mkdir -p "$PWD/backups"
# umask only covers what this run creates (pass 63). Snapshots written by the
# pre-pass-55 script are the ones that matter: they landed root-owned or 0644
# and nothing ever revisits their modes, so the full user-image/video tree
# stayed readable by every local account. Tighten the directory and any
# existing tree before the new snapshot lands. Best-effort on the tree: a
# root-owned legacy snapshot belongs to the operator, but the new snapshot is
# still owner-only by umask.
chmod 700 "$PWD/backups"
if [ -d "$PWD/backups/objects" ] && ! chmod -R go-rwx "$PWD/backups/objects" 2>/dev/null; then
  echo "[backup-objects] warning: could not tighten every existing snapshot (root-owned?); this run's snapshot is owner-only" >&2
fi

# The uid is the invoking user's, not root: the snapshot tree (every user image
# and video, unencrypted) landed root-owned when this script ran, and the
# documented recovery reads it as the operator (pass 55). The image has no
# passwd entry for an arbitrary uid and $HOME resolves to /, which it cannot
# write — mc saves its alias config under $HOME/.mc, so `mc alias set` died
# with "Unable to save new mc config" and the redirection hid it (pass 56).
docker run --rm \
  --user "$(id -u):$(id -g)" \
  --entrypoint /bin/sh \
  -e HOME=/tmp \
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
    HOME=/tmp
    export HOME
    # Credentials go to mc through its CHILD ENVIRONMENT (MC_HOST_*), never as
    # argv: `mc alias set <url> <key> <secret>` writes the secret into
    # /proc/<pid>/cmdline, which every local account can read for the duration
    # of the mirror. Percent-encode the URL-significant characters first.
    enc() {
      _s="$1"; _o=""
      while [ -n "$_s" ]; do
        _c="${_s%"${_s#?}"}"
        _s="${_s#?}"
        case "$_c" in
          [a-zA-Z0-9._~-]) _o="$_o$_c" ;;
          %) _o="${_o}%25" ;;
          @) _o="${_o}%40" ;;
          :) _o="${_o}%3A" ;;
          /) _o="${_o}%2F" ;;
          [?]) _o="${_o}%3F" ;;
          [#]) _o="${_o}%23" ;;
          " ") _o="${_o}%20" ;;
          *) _o="$_o$_c" ;;
        esac
      done
      printf "%s" "$_o"
    }
    setup_src() {
      case "$SRC_ENDPOINT" in *://*) ;; *) return 1 ;; esac
      _scheme="${SRC_ENDPOINT%%://*}"
      _rest="${SRC_ENDPOINT#*://}"
      MC_HOST_src="${_scheme}://$(enc "$SRC_ACCESS"):$(enc "$SRC_SECRET")@${_rest}"
      export MC_HOST_src
    }
    setup_tgt() {
      case "$TARGET_ENDPOINT" in *://*) ;; *) return 1 ;; esac
      _scheme="${TARGET_ENDPOINT%%://*}"
      _rest="${TARGET_ENDPOINT#*://}"
      MC_HOST_tgt="${_scheme}://$(enc "$TARGET_ACCESS"):$(enc "$TARGET_SECRET")@${_rest}"
      export MC_HOST_tgt
    }
    # Never silent: a wrong endpoint used to be swallowed by the redirection and
    # surface only as an empty-snapshot failure (pass 56).
    if ! setup_src; then
      echo "[backup-objects] FAILED: BACKUP_S3_ENDPOINT needs a scheme (http://host:port) — got ${SRC_ENDPOINT}" >&2
      exit 1
    fi
    STAMP=$(date +%Y%m%d-%H%M%S)
    rm -rf /backups/objects/.*.partial
    mc mirror --overwrite --remove "src/$SRC_BUCKET" "/backups/objects/.$STAMP.partial"
    # `mc mirror` exits 0 on an EMPTY source. Without this test a recreated or
    # emptied bucket produced a valid-looking empty snapshot, the rotation below
    # deleted the oldest COMPLETE snapshot, and the off-site leg then wiped its
    # target too (`--remove` from an empty source). The bucket being empty is
    # exactly what a compromised or misconfigured endpoint looks like, so it is
    # a failure, not a backup.
    #
    # `find` is not in the pinned mc image (pass 56), so count with the mc
    # client recursive listing: one line per object, 0 for an empty directory.
    # The old `find … | wc -l` answered 0 in that image for EVERY source, so
    # this script refused every backup it ever took.
    COUNT=$(mc ls --recursive --quiet "/backups/objects/.$STAMP.partial" 2>/dev/null | wc -l | tr -d " ")
    if [ "$COUNT" -eq 0 ]; then
      echo "[backup-objects] FAILED: $SRC_BUCKET produced 0 objects — refusing to rotate or mirror an empty snapshot (previous snapshots are untouched)" >&2
      rm -rf "/backups/objects/.$STAMP.partial"
      exit 1
    fi
    mv "/backups/objects/.$STAMP.partial" "/backups/objects/$STAMP"
    # `grep`/`awk`/`sed` are not in the image either (pass 56), so the
    # YYYYMMDD-HHMMSS filter is done with the shell case statement. Only our
    # snapshots are rotated; operator-owned files in this directory are left
    # untouched.
    ls -1t /backups/objects/ | while read -r f; do
      case "$f" in
        [0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]-[0-9][0-9][0-9][0-9][0-9][0-9]) echo "$f" ;;
      esac
    done | tail -n +$((KEEP + 1)) | while read -r f; do rm -rf "/backups/objects/$f"; done
    echo "[backup-objects] $STAMP mirrored from $SRC_BUCKET ($COUNT objects, keeping $KEEP snapshots)"
    if [ -n "$TARGET_ENDPOINT" ]; then
      if ! setup_tgt; then
        echo "[backup-objects] off-site mirror FAILED at $STAMP (BACKUP_TARGET_ENDPOINT needs a scheme; the local snapshot is complete)" >&2
      else
        # Mirror the SNAPSHOT, not the live bucket: the source can be emptied
        # between the two legs, and `--remove` would then erase the off-site
        # copy as well. The validated snapshot is the thing being backed up.
        #
        # The snapshot goes under its OWN stamp prefix and is rotated like the
        # local copies. It used to mirror into the target bucket root, so the
        # off-site copy always equaled the previous night of live state: a
        # partial deletion (compromised credentials, a mass-delete bug) was
        # copied off-site on the next run, while the only history sat on the
        # same host the off-site copy exists to survive (pass 54). Point-in-time
        # prefixes keep the off-site copy able to restore something older than
        # the most recent mistake; the local snapshot was already validated
        # non-empty.
        mc mb -p "tgt/$TARGET_BUCKET" >/dev/null 2>&1 || true
        if mc mirror --overwrite --remove "/backups/objects/$STAMP" "tgt/$TARGET_BUCKET/$STAMP"; then
          # Count-based rotation over the stamp prefixes only. `mc ls` prints
          # directory names with a trailing slash; anything that is not one of
          # our YYYYMMDD-HHMMSS names (operator-owned objects, an old flat-layout
          # snapshot) is left untouched. The filter is the shell case statement
          # because `grep` is absent from the pinned image (pass 56) — the old
          # pipeline silently pruned nothing at all.
          mc ls "tgt/$TARGET_BUCKET" 2>/dev/null | tr -s " " "\n" | while read -r f; do
            case "$f" in
              [0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]-[0-9][0-9][0-9][0-9][0-9][0-9]/) echo "${f%/}" ;;
            esac
          done | sort -r | tail -n +$((KEEP + 1)) | while read -r old; do
            mc rm --recursive --force "tgt/$TARGET_BUCKET/$old" || echo "[backup-objects] could not prune off-site snapshot $old" >&2
            echo "[backup-objects] off-site snapshot $old pruned"
          done
          echo "[backup-objects] off-site mirror to $TARGET_BUCKET/$STAMP done"
        else
          echo "[backup-objects] off-site mirror FAILED at $STAMP (the local snapshot is complete)" >&2
        fi
      fi
    fi
  '
