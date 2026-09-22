#!/usr/bin/env bash
# Local replica of .github/workflows/ci.yml — proves the pipeline passes
# before pushing (unit tests, typecheck, production build, e2e).
# Requires: local Postgres 16 + Redis (e.g. `docker compose up -d db redis`).
set -euo pipefail

export DATABASE_URL="postgresql://pixelduo:pixelduo@localhost:5432/pixelduo_test"
export TEST_DATABASE_URL="$DATABASE_URL"
export NEXTAUTH_SECRET="5c1f8e2a94b7d03f6ae4c81d2795bf30e6a1c47d8b92f650"
export REDIS_URL="redis://localhost:6379"
export MOCK_IMAGE_PROVIDER="1"
export MIDDLEWARE_AUTH_LIMIT="1000"
export MIDDLEWARE_API_LIMIT="10000"
export REGISTER_RATE_LIMIT="10000"
export STORAGE_DRIVER="local"
export LOCAL_STORAGE_DIR="data/files"

echo "[1/7] prisma generate + migrate"
npx prisma generate >/dev/null
npx prisma migrate deploy >/dev/null

echo "[2/7] typecheck (tsc --noEmit)"
npx tsc --noEmit

echo "[3/7] unit tests"
# Mirrors CI: the test-unit job does NOT auto-verify (auth-flow covers the
# pending-verification flow); only the e2e job sets EMAIL_VERIFY_AUTO=1.
unset EMAIL_VERIFY_AUTO || true
# Rate-limit counters persist in Redis between local runs (CI gets a fresh
# instance); clear them so repeated local runs don't trip auth-flow tests.
docker exec pixelduo-redis redis-cli --scan --pattern 'rl:*' 2>/dev/null \
  | xargs -r -I{} docker exec pixelduo-redis redis-cli del {} >/dev/null 2>&1 || true
npm test

echo "[4/7] production build"
# The build bakes NEXTAUTH_URL into the prerendered metadata (og:url/og:image —
# see lib/site.ts and the Dockerfile's build ARG), and CI's e2e job exports the
# same value before `npm run build`. Without it here the built pages carry the
# http://localhost:3000 fallback, and the e2e assertion that the served origin is
# the configured one would fail on a tree CI considers green — a divergence
# between the pipeline this script claims to replicate and the one that runs.
export NEXTAUTH_URL="http://localhost:3100"
npm run build

echo "[5/7] seed + start app/worker (port 3100)"
export EMAIL_VERIFY_AUTO="1" # e2e needs auto-verified registrations
export PAYMENT_ALLOW_MOCK="1" # test the checkout flow against a prod build
# Email links are built from NEXTAUTH_URL, and .env's default points at the dev
# port — a spec that follows a reset link must land on the app it is talking to.
export NEXTAUTH_URL="http://localhost:3100"
# Makes the log-only mailer write each message to disk so a spec can read the
# link out of it (lib/mail.ts DevMailer). Fresh per run: a stale file would hand
# a spec the previous run's token.
export MAIL_DEV_DIR="${MAIL_DEV_DIR:-/tmp/pd-ci-mail}"
rm -rf "$MAIL_DEV_DIR" && mkdir -p "$MAIL_DEV_DIR"
# The e2e stage shares one Redis and one source IP across every spec, and unlike
# CI (which gets a fresh instance) repeated local runs accumulate the per-IP
# route counters until an unrelated limit trips. Same reset as the unit stage.
docker exec pixelduo-redis redis-cli --scan --pattern 'rl:*' 2>/dev/null \
  | xargs -r -I{} docker exec pixelduo-redis redis-cli del {} >/dev/null 2>&1 || true
npx tsx prisma/seed.ts >/dev/null
npx next start -p 3100 >/tmp/pd-ci-app.log 2>&1 &
APP_PID=$!
npx tsx scripts/worker.ts >/tmp/pd-ci-worker.log 2>&1 &
WORKER_PID=$!
trap 'kill $APP_PID $WORKER_PID 2>/dev/null || true' EXIT

for i in $(seq 1 30); do
  curl -fsS http://localhost:3100/api/health >/dev/null 2>&1 && break
  sleep 2
done
curl -fsS http://localhost:3100/api/health >/dev/null

echo "[6/7] e2e"
PW_CHANNEL=chrome npx playwright test

# The pending-verification flow cannot share a process with the auto-verified
# one — EMAIL_VERIFY_AUTO is read at registration time — so that spec gets a
# second instance of the same build on its own port. The worker is shared: it
# polls the database, not either app.
echo "[7/7] e2e (pending-verification flow, port 3101)"
export EMAIL_VERIFY_AUTO="0"
export NEXTAUTH_URL="http://localhost:3101"
npx next start -p 3101 >/tmp/pd-ci-app-verify.log 2>&1 &
APP2_PID=$!
trap 'kill $APP_PID $APP2_PID $WORKER_PID 2>/dev/null || true' EXIT

for i in $(seq 1 30); do
  curl -fsS http://localhost:3101/api/health >/dev/null 2>&1 && break
  sleep 2
done
curl -fsS http://localhost:3101/api/health >/dev/null

PW_BASE_URL="http://localhost:3101" PW_CHANNEL=chrome \
  npx playwright test e2e/verify-email.spec.ts

echo "CI-LOCAL PASSED — pipeline is green locally"
