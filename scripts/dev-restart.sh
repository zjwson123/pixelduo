#!/usr/bin/env bash
# Restart the LOCAL dev stack (app on :3000 + media worker) with the env it
# actually needs. Written 2026-09-20 after `ci-local.sh` rebuilt .next under a
# running `next start`, which made every page render the error boundary
# ("出了点问题") while the server still answered 200 — see the memory note
# "the inverse pitfall" in dev-environment-workflow.md.
#
# Usage: bash scripts/dev-restart.sh
set -euo pipefail
cd "$(dirname "$0")/.."

# The running process's env is unreadable on macOS; .env supplies only part of
# what the server needs, so the rest is reconstructed here (values match
# docker-compose.yml's dev defaults + the MinIO container).
set -a; source .env; set +a
export REDIS_URL="${REDIS_URL:-redis://localhost:6379}"
# Required for the production-mode boot assertions: NEXTAUTH_URL is http://
# locally, and PAYMENT_PROVIDER=mock is refused in production without this flag.
export PAYMENT_ALLOW_MOCK="${PAYMENT_ALLOW_MOCK:-1}"
export EMAIL_VERIFY_AUTO="${EMAIL_VERIFY_AUTO:-1}"
export STORAGE_DRIVER=s3
export S3_ENDPOINT=http://localhost:9000
export S3_REGION=us-east-1
export S3_BUCKET=pixelduo
export S3_FORCE_PATH_STYLE=true
# Mail: unset (or empty) → the log-only DevMailer, which prints every message —
# verification and reset links included — to /tmp/pd-dev-app.log. Export
# SMTP_URL to exercise the real transport instead, e.g. against the local sink:
#   node scripts/dev-smtp-sink.mjs 2525 /tmp/pd-smtp-inbox.log &
#   SMTP_URL=smtp://127.0.0.1:2525 bash scripts/dev-restart.sh
# (a real provider: smtp://user:pass@host:port — Gmail needs an app password).
export SMTP_URL="${SMTP_URL:-}"
export EMAIL_FROM="${EMAIL_FROM:-PixelDuo <no-reply@pixelduo.ai>}"
# Credentials come from the MinIO container, so they are never written to disk.
if [ -z "${S3_ACCESS_KEY_ID:-}" ]; then
  minio_env="$(docker inspect pixelduo-storage --format '{{range .Config.Env}}{{println .}}{{end}}')"
  export S3_ACCESS_KEY_ID="$(sed -n 's/^MINIO_ROOT_USER=//p' <<<"$minio_env")"
  export S3_SECRET_ACCESS_KEY="$(sed -n 's/^MINIO_ROOT_PASSWORD=//p' <<<"$minio_env")"
fi

echo "[1/3] stopping stale app + worker"
pkill -9 -f "next start" || true
pkill -9 -f "next-server" || true
# The real command line is `node --require …/tsx/dist/preflight.cjs --import …
# scripts/worker.ts` — the string "tsx scripts/worker" never occurs in it, so
# this pattern matched nothing: every restart left the old workers polling the
# same queue (twenty had accumulated, and jobs completed "by themselves" after
# a restart). Verify the kill instead of trusting the pattern.
pkill -9 -f "scripts/worker.ts" || true
sleep 1
stale_workers="$(ps -eo command | grep -c '[s]cripts/worker\.ts' || true)"
if [ "$stale_workers" != "0" ]; then
  echo "ERROR: $stale_workers worker process(es) survived the kill" >&2
  exit 1
fi
if [ -n "$(lsof -ti:3000 || true)" ]; then
  echo "ERROR: port 3000 is still held: $(lsof -ti:3000 | tr '\n' ' ')" >&2
  exit 1
fi

echo "[2/3] starting app + worker (logs: /tmp/pd-dev-app.log, /tmp/pd-dev-worker.log)"
nohup npx next start -p 3000 >/tmp/pd-dev-app.log 2>&1 &
nohup npx tsx scripts/worker.ts >/tmp/pd-dev-worker.log 2>&1 &

echo "[3/3] verifying"
for _ in $(seq 1 30); do
  curl -fsS http://localhost:3000/api/health >/dev/null 2>&1 && break
  sleep 1
done
health="$(curl -fsS http://localhost:3000/api/health)"
echo "  health: $health"
grep -q '"ok":true' <<<"$health" || { echo "ERROR: health not ok" >&2; exit 1; }
grep -q 'media worker started' /tmp/pd-dev-worker.log || { echo "ERROR: worker did not start" >&2; tail -5 /tmp/pd-dev-worker.log >&2; exit 1; }
echo "  pages:"
for p in / /login /register; do
  printf '    %-10s %s\n' "$p" "$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:3000$p")"
done
echo "OK — app :3000 + worker up on the current build (.next/BUILD_ID=$(cat .next/BUILD_ID))"
