#!/usr/bin/env bash
# Local replica of .github/workflows/ci.yml — proves the pipeline passes
# before pushing (unit tests, typecheck, production build, e2e).
# Requires: local Postgres 16 + Redis (e.g. `docker compose up -d db redis`).
set -euo pipefail

export DATABASE_URL="postgresql://pixelduo:pixelduo@localhost:5432/pixelduo_test"
export TEST_DATABASE_URL="$DATABASE_URL"
export NEXTAUTH_SECRET="ci-local-secret"
export REDIS_URL="redis://localhost:6379"
export MOCK_IMAGE_PROVIDER="1"
export MIDDLEWARE_AUTH_LIMIT="1000"
export MIDDLEWARE_API_LIMIT="10000"
export REGISTER_RATE_LIMIT="10000"
export STORAGE_DRIVER="local"
export LOCAL_STORAGE_DIR="data/files"

echo "[1/6] prisma generate + migrate"
npx prisma generate >/dev/null
npx prisma migrate deploy >/dev/null

echo "[2/6] typecheck (tsc --noEmit)"
npx tsc --noEmit

echo "[3/6] unit tests"
# Mirrors CI: the test-unit job does NOT auto-verify (auth-flow covers the
# pending-verification flow); only the e2e job sets EMAIL_VERIFY_AUTO=1.
unset EMAIL_VERIFY_AUTO || true
# Rate-limit counters persist in Redis between local runs (CI gets a fresh
# instance); clear them so repeated local runs don't trip auth-flow tests.
docker exec pixelduo-redis redis-cli --scan --pattern 'rl:*' 2>/dev/null \
  | xargs -r -I{} docker exec pixelduo-redis redis-cli del {} >/dev/null 2>&1 || true
npm test

echo "[4/6] production build"
npm run build

echo "[5/6] seed + start app/worker (port 3100)"
export EMAIL_VERIFY_AUTO="1" # e2e needs auto-verified registrations
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

echo "[6/6] e2e"
PW_CHANNEL=chrome npx playwright test

echo "CI-LOCAL PASSED — pipeline is green locally"
