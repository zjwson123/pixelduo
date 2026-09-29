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

echo "[1/9] deployment config (compose render + env-var coverage)"
# Mirrors CI's `config` job: renders every compose file and asserts that each
# variable documented in .env.example AND read by the code actually reaches a
# container. Needs docker (this script already requires it for db/redis).
npx tsx scripts/check-config.ts

echo "[2/9] container image (dependency stage)"
# Mirrors CI's `docker` job. The build is the deploy artifact and it had been
# broken for three weeks with nothing in this script able to see it: `npm ci`
# cannot install this lockfile without .npmrc, and no Dockerfile stage copied it,
# while every host-side step here runs with .npmrc next to the manifests.
docker build --progress=plain --target deps . > /tmp/pd-ci-docker.log 2>&1 \
  || { echo "docker build --target deps FAILED — see /tmp/pd-ci-docker.log"; tail -20 /tmp/pd-ci-docker.log; exit 1; }

echo "[3/9] prisma generate + migrate"
npx prisma generate >/dev/null
npx prisma migrate deploy >/dev/null

echo "[4/9] typecheck (tsc --noEmit)"
npx tsc --noEmit

echo "[5/9] unit tests"
# Mirrors CI: the test-unit job does NOT auto-verify (auth-flow covers the
# pending-verification flow); only the e2e job sets EMAIL_VERIFY_AUTO=1.
unset EMAIL_VERIFY_AUTO || true
# Rate-limit counters persist in Redis between local runs (CI gets a fresh
# instance); clear them so repeated local runs don't trip auth-flow tests.
docker exec pixelduo-redis redis-cli --scan --pattern 'rl:*' 2>/dev/null \
  | xargs -r -I{} docker exec pixelduo-redis redis-cli del {} >/dev/null 2>&1 || true
npm test

echo "[6/9] production build"
# The build bakes NEXTAUTH_URL into the prerendered metadata (og:url/og:image —
# see lib/site.ts and the Dockerfile's build ARG), and CI's e2e job exports the
# same value before `npm run build`. Without it here the built pages carry the
# http://localhost:3000 fallback, and the e2e assertion that the served origin is
# the configured one would fail on a tree CI considers green — a divergence
# between the pipeline this script claims to replicate and the one that runs.
export NEXTAUTH_URL="http://localhost:3100"
npm run build

# The artifact that deploys must not carry the build host's secrets. `next
# build` copies .env into .next/standalone unconditionally; the postbuild prune
# is what removes it, and a silent failure here ships NEXTAUTH_SECRET and the
# database URL with the artifact. Same assertion as CI's build job.
LEAKED="$(find .next/standalone -maxdepth 2 -name '.env*' -not -path '*/node_modules/*' 2>/dev/null || true)"
if [ -n "$LEAKED" ]; then
  echo "standalone artifact carries dotenv files:" >&2
  echo "$LEAKED" >&2
  exit 1
fi

echo "[7/9] seed + start app/worker (port 3100)"
export EMAIL_VERIFY_AUTO="1" # e2e needs auto-verified registrations
export PAYMENT_ALLOW_MOCK="1" # test the checkout flow against a prod build
# Email links are built from NEXTAUTH_URL, and .env's default points at the dev
# port — a spec that follows a reset link must land on the app it is talking to.
export NEXTAUTH_URL="http://localhost:3100"
# Makes the log-only mailer write each message to disk so a spec can read the
# link out of it (lib/mail.ts DevMailer). Fresh per run: a stale file would hand
# a spec the previous run's token.
# ${VAR:-default} only defends the UNSET case: a MAIL_DEV_DIR already exported in
# the caller's shell (or a typo'd CI variable) was passed straight to `rm -rf`,
# i.e. this script deleted whatever directory the environment named. Refuse
# anything that is not recognisably this script's own scratch directory, and
# never let "/" or an empty value through.
DEFAULT_MAIL_DEV_DIR="/tmp/pd-ci-mail"
case "${MAIL_DEV_DIR:-$DEFAULT_MAIL_DEV_DIR}" in
  # `..` first: the /tmp/* arm below matched "/tmp/../Users/<user>/x" textually,
  # so the one typo this guard exists for ("I meant /tmp/pd-ci-mail") still
  # handed the `rm -rf` on line 74 a directory outside /tmp.
  *..*)
    echo "refusing to rm -rf MAIL_DEV_DIR='$MAIL_DEV_DIR' — it must not contain '..'" >&2
    exit 1
    ;;
  /tmp/pd-ci-mail|/tmp/pd-ci-mail/*|/tmp/*|/var/folders/*|"$PWD"/.tmp*) ;;
  *)
    echo "refusing to rm -rf MAIL_DEV_DIR='$MAIL_DEV_DIR' — set it to a directory under /tmp (or unset it)" >&2
    exit 1
    ;;
esac
export MAIL_DEV_DIR="${MAIL_DEV_DIR:-$DEFAULT_MAIL_DEV_DIR}"
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

echo "[8/9] e2e"
PW_CHANNEL=chrome npx playwright test

# The pending-verification flow cannot share a process with the auto-verified
# one — EMAIL_VERIFY_AUTO is read at registration time — so that spec gets a
# second instance of the same build on its own port. The worker is shared: it
# polls the database, not either app.
echo "[9/9] e2e (pending-verification flow, port 3101)"
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
