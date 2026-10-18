#!/usr/bin/env bash
# Local replica of .github/workflows/ci.yml — proves the pipeline passes
# before pushing (unit tests, typecheck, production build, e2e).
# Requires: local Postgres 16 + Redis (e.g. `docker compose up -d db redis`).
set -euo pipefail
# Everything this script writes (/tmp logs, MAIL_DEV_DIR, build logs) can contain
# LIVE reset/verification tokens from the e2e flows; keep it owner-only on a
# shared host or self-hosted runner (pass 39).
umask 077

export DATABASE_URL="postgresql://pixelduo:pixelduo@localhost:5432/pixelduo_test"
export TEST_DATABASE_URL="$DATABASE_URL"
export NEXTAUTH_SECRET="5c1f8e2a94b7d03f6ae4c81d2795bf30e6a1c47d8b92f650"
export REDIS_URL="redis://localhost:6379"
export MOCK_IMAGE_PROVIDER="1"
export MIDDLEWARE_AUTH_LIMIT="1000"
export MIDDLEWARE_API_LIMIT="10000"
export MIDDLEWARE_PAGE_LIMIT="10000"
export REGISTER_RATE_LIMIT="10000"
export STORAGE_DRIVER="local"
export LOCAL_STORAGE_DIR="data/files"

# The npx wrapper's death does not reliably reach the node child (this
# pipeline's own recorded pitfall: an aborted run's `next start` survives, the
# next run's health check passes against ITS build, and the whole e2e stage
# tests a stale artifact). The trap is installed HERE, before anything can
# leak — a smoke container this script starts at step 2 outlived a step-5
# failure in the first version, and the next run then died on "name already in
# use". Listeners are taken down by port as well as by pid, but only for ports
# this run actually started, so an unrelated process is never killed on an
# early exit.
STARTED_PORTS=()
cleanup() {
  # The build-host plant below must not survive this script, however it exits
  # (pass 34): CI removes it in a separate step after the assertion, and a
  # failure or Ctrl-C here would otherwise leave a fake .env in the checkout.
  if [ -n "${PLANTED_ENV:-}" ]; then rm -f .env prisma/dev.db; fi
  kill ${APP_PID:-} ${APP2_PID:-} ${WORKER_PID:-} 2>/dev/null || true
  for p in ${STARTED_PORTS[@]+"${STARTED_PORTS[@]}"}; do
    pids="$(lsof -ti "tcp:$p" 2>/dev/null || true)"
    if [ -n "$pids" ]; then kill $pids 2>/dev/null || true; fi
  done
  docker rm -f pd-ci-web-smoke >/dev/null 2>&1 || true
  docker rm -f pd-ci-worker-smoke >/dev/null 2>&1 || true
}
trap cleanup EXIT
# An interrupt must still clean up: without these, a Ctrl-C leaves the smoke
# container (and any listener) behind, and the NEXT run refuses to start on its
# own leak — which is exactly how the first version of this smoke behaved.
trap 'exit 130' INT TERM

echo "[1/9] deployment config (compose render + env-var coverage) + runtime advisories"
# Mirrors CI's `config` job: renders every compose file and asserts that each
# variable documented in .env.example AND read by the code actually reaches a
# container. Needs docker (this script already requires it for db/redis).
npx tsx scripts/check-config.ts
# The other half of that job: an advisory that appears WITHOUT a commit, in the
# runtime tree already shipped — nodemailer 10.0.1 and next 16.3.4 were both
# found by hand in the daily pass. `--omit=dev` because a dev-only
# vitest/vite advisory must not fail a deploy gate; `--audit-level=high` because
# moderate ones are reported by the daily pass rather than blocking. The
# registry's audit endpoint occasionally errors out, and npm exits non-zero for
# that too — retry only that case, and never report a clean tree it did not
# confirm. Needs the registry to answer.
audited=0
for attempt in 1 2 3; do
  if out="$(npm audit --omit=dev --audit-level=high 2>&1)"; then
    echo "$out"; audited=1; break
  fi
  echo "$out"
  if printf '%s' "$out" | grep -qi "audit endpoint returned an error"; then
    echo "[audit] registry audit endpoint unavailable (attempt $attempt/3) — retrying"
    sleep 5
  else
    exit 1
  fi
done
[ "$audited" = 1 ] || { echo "[audit] the registry audit endpoint stayed unavailable — refusing to report a runtime tree it never checked"; exit 1; }

echo "[2/9] container images (deps + web + worker, artifact asserted)"
# Mirrors CI's `docker` job. The build is the deploy artifact and it had been
# broken for three weeks with nothing in this script able to see it: `npm ci`
# cannot install this lockfile without .npmrc, and no Dockerfile stage copied it,
# while every host-side step here runs with .npmrc next to the manifests.
#
# One retry per stage: the worker stage runs `npx prisma generate`, which
# fetches the Prisma query engine from binaries.prisma.sh at build time (a
# transient TLS disconnect failed this step's first run), and a network blip
# must not read as a broken Dockerfile. Same rule as the npm-audit retry above:
# retry the network; never report a build that did not finish.
run_build() {
  local label="$1"; shift
  for attempt in 1 2; do
    if docker build --progress=plain "$@" . >> /tmp/pd-ci-docker.log 2>&1; then return 0; fi
    echo "[docker] $label build failed (attempt $attempt/2) — see /tmp/pd-ci-docker.log"
    if [ "$attempt" = 1 ]; then sleep 5; else return 1; fi
  done
}
run_build deps --target deps \
  || { echo "docker build --target deps FAILED — see /tmp/pd-ci-docker.log"; tail -20 /tmp/pd-ci-docker.log; exit 1; }
# Pass 27: deps alone left the two RUNTIME stages unbuilt by any job, and a
# regression in exactly those instructions (public/ and prisma/ copied into
# themselves — a 13 MB duplicate plus a second URL space) shipped with green
# CI. Build both deploy stages and assert the web artifact's shape, the same
# checks CI runs. NEXTAUTH_URL is required in practice: the /login prerender
# imports next-auth/react, which builds new URL() from it, so an arg-less build
# fails with TypeError: Invalid URL (found by this step the first time it ran).
run_build web --target web -t pd-ci-web --build-arg NEXTAUTH_URL=http://localhost:3100 \
  || { echo "docker build --target web FAILED — see /tmp/pd-ci-docker.log"; tail -20 /tmp/pd-ci-docker.log; exit 1; }
run_build worker --target worker -t pd-ci-worker \
  || { echo "docker build --target worker FAILED — see /tmp/pd-ci-docker.log"; tail -20 /tmp/pd-ci-docker.log; exit 1; }
docker run --rm --entrypoint sh pd-ci-web -c '
  set -e
  test -e /app/public/templates
  test -e /app/prisma/schema.prisma
  test ! -e /app/public/public
  test ! -e /app/prisma/prisma
  # The reachable entries of the web prune (pass 31). docs/tests/e2e cannot be
  # in this image at all (outputFileTracingExcludes removes them from
  # .next/standalone, which is all the web stage copies), so the three `test !`s
  # that used to sit here were true no matter what the prune list said; these
  # seven ARE traced into the tree and only the prune removes them. Same block
  # as ci.yml — a dropped name must fail both gates.
  test ! -e /app/designs
  test ! -e /app/docker-compose.yml
  test ! -e /app/docker-compose.single.yml
  test ! -e /app/docker-compose.prod.yml
  test ! -e /app/Caddyfile
  test ! -e /app/README.md
  test ! -e /app/tsconfig.tsbuildinfo
  test ! -e /app/Dockerfile
  # The TypeScript sources (pass 32): the tracer keeps them for prerender source
  # maps, so the image shipped the backend source (lib/ledger.ts names every
  # fixed weakness and its pass), the operator scripts and the dev configs.
  # None of it is read at runtime — the boot smoke below is what proves that.
  test ! -e /app/lib
  test ! -e /app/scripts
  test ! -e /app/app
  test ! -e /app/components
  test ! -e /app/proxy.ts
  test ! -e /app/instrumentation.ts
  test ! -e /app/next.config.mjs
  test ! -e /app/vitest.config.ts
  test ! -e /app/playwright.config.ts
  test ! -e /app/tsconfig.json
  test ! -e /app/prisma/seed.ts
  # Pass 34: the two glob expansions the prune list carries and no assertion
  # named. PRODUCT_OUTLINE.md is 33 KB of internal monetisation notes and is
  # traced into .next/standalone (probed); only ./*.md removes it.
  #
  # .env.example is deliberately NOT asserted here (pass 37). The pass-34 note
  # claimed it was "the one dotenv name the build context DOES carry, so unlike
  # the three below it can actually fail" — true of the CONTEXT, false of this
  # STAGE: the web stage copies only .next/standalone, .next/static, public/ and
  # prisma/, and the standalone writer in Next takes requiredServerFiles.files
  # plus .env/.env.production only (no apostrophes anywhere in this block: it is
  # one single-quoted shell string, and a stray quote ends it early — pass 33).
  # It appears in ZERO trace manifests and cannot reach /app, so the assertion
  # that used to sit on this line was true no matter what the prune list said
  # (probed against the trace manifests this build wrote). The worker stage DOES
  # carry it and still asserts it below. What replaces it are the names that are
  # genuinely traced into standalone AND named by this prune — drop one from the
  # prune list and the artifact ships it with the gate green:
  test ! -e /app/PRODUCT_OUTLINE.md
  test ! -e /app/instrumentation-client.ts
  test ! -e /app/sentry.server.config.ts
  test ! -e /app/sentry.edge.config.ts
  test ! -e /app/vitest.setup.ts
  # ...while what actually RUNS is still there: the compiled chunks.
  test -e /app/server.js
  test -e /app/.next/server/instrumentation.js
  test -e /app/.next/server/middleware.js
  # The Prisma client dotenv hook (pass 38). The tree carries a generated
  # client whose config resolves ../../../.env against its own directory, so ANY
  # dotenv placed beside the artifact loaded into every process importing it —
  # the boot gates included — while docs/deploy.md said such a file configures
  # nothing. postbuild rewrites those paths to null; assert the IMAGE carries
  # the rewrite. (No apostrophes in this block: it is one single-quoted shell
  # string, and a stray quote ends it early — pass 33.)
  test -e /app/node_modules/.prisma/client/index.js
  grep -q "\"schemaEnvPath\": null" /app/node_modules/.prisma/client/index.js
  grep -q "__NEXT_PROCESSED_ENV" /app/server.js
  for f in /app/.env /app/.env.local /app/.env.production; do
    if [ -e "$f" ]; then echo "dotenv in image: $f"; exit 1; fi
  done
  echo "web image shape OK"
' || { echo "web image artifact assertion FAILED"; exit 1; }
# The deploy artifact had never been BOOTED by any job (pass 32): the gates
# above assert file shape only, and the e2e stage runs `next start` from the
# repo tree — never standalone/server.js, which is what every compose file
# deploys. A standalone tree that builds but cannot start (a traced dependency
# silently absent, a broken server.js, a query engine for the wrong platform)
# shipped with every job green. Boot the real image against the local database
# and require a real /api/health. host.docker.internal because the compose
# database is published on the host; the image pins its own UTC session.
# rm -f first: a container this script left behind (a killed run before the
# trap existed) must not block the name.
#
# The schema must exist before the boot: the smoke runs the REAL query path
# (/api/health reads Job), and on a fresh machine this stage used to run before
# the migrate step, so the app would answer 503 "the table public.Job does not
# exist" — exactly what remote CI hit on this gate's first run. migrate deploy
# is idempotent; step 3 runs it again for the rest of the pipeline.
npx prisma migrate deploy >/dev/null
docker rm -f pd-ci-web-smoke >/dev/null 2>&1 || true
docker run -d --name pd-ci-web-smoke -p 3109:3000 \
  --add-host=host.docker.internal:host-gateway \
  -e DATABASE_URL="postgresql://pixelduo:pixelduo@host.docker.internal:5432/pixelduo_test" \
  -e REDIS_URL="redis://host.docker.internal:6379" \
  -e NEXTAUTH_SECRET="$NEXTAUTH_SECRET" \
  -e NEXTAUTH_URL="http://localhost:3109" \
  -e PAYMENT_ALLOW_MOCK=1 \
  -e STORAGE_DRIVER=local \
  pd-ci-web >/dev/null
smoke_ok=""
for i in $(seq 1 30); do
  curl -fsS http://127.0.0.1:3109/api/health >/dev/null 2>&1 && { smoke_ok=1; break; }
  sleep 2
done
if [ -z "$smoke_ok" ]; then
  echo "web image boot smoke FAILED — the standalone server never answered /api/health:" >&2
  docker logs pd-ci-web-smoke 2>&1 | tail -30 >&2
  exit 1
fi
echo "web image boots standalone and answers /api/health"
# Take it down NOW, not at exit: it published 3109, and the e2e stage's
# leftover-listener guard five steps below refuses to start while anything
# holds that port (a first version left the smoke up for the whole run and
# tripped its own check).
docker rm -f pd-ci-web-smoke >/dev/null 2>&1 || true
# Same rule for the worker image (see ci.yml): its prune is what keeps docs/,
# tests/ and any planted .env out of the artifact a registry push carries off
# the host, and nothing asserted it until pass 28.
docker run --rm --entrypoint sh pd-ci-worker -c '
  set -e
  test -e /app/package.json
  test -e /app/prisma/schema.prisma
  test -e /app/lib/queue.ts
  test -e /app/scripts/worker.ts
  test -x /app/node_modules/.bin/tsx
  test ! -e /app/docs
  test ! -e /app/tests
  test ! -e /app/e2e
  test ! -e /app/designs
  test ! -e /app/perf
  test ! -e /app/public/showcase
  test ! -e /app/Dockerfile
  test ! -e /app/docker-compose.yml
  test ! -e /app/Caddyfile
  test ! -e /app/README.md
  # The dot-entries (pass 30): in the build context, named by no prune list before,
  # and outside every assertion — ci.yml (deploy invariants + the published CI
  # secret) shipped in the worker image with the gate unable to see it.
  test ! -e /app/.github
  test ! -e /app/.npmrc
  test ! -e /app/.gitignore
  test ! -e /app/.dockerignore
  # Pass 34: the two compose files the web gate already asserts and this one
  # did not, plus the same md/dotenv glob members as the web gate. This is the
  # registry-pushed image; dropping a name from its prune list shipped the file
  # with every gate green.
  test ! -e /app/docker-compose.single.yml
  test ! -e /app/docker-compose.prod.yml
  test ! -e /app/PRODUCT_OUTLINE.md
  test ! -e /app/.env.example
  # The editor state a build host may carry (pass 31): gitignored, so invisible
  # to every "is it in the repo" check, and previously named by neither
  # .dockerignore nor this prune — .vscode/settings.json and .idea/workspace.xml
  # routinely hold pasted tokens and private hostnames. All five names are here
  # (pass 33): the three the pass-31 gate did not assert could be dropped from
  # both lists with every gate green.
  test ! -e /app/.vscode
  test ! -e /app/.idea
  test ! -e /app/.claude
  test ! -e /app/.cursor
  for f in /app/*.swp; do if [ -e "$f" ]; then echo "editor swap file in image: $f"; exit 1; fi; done
  for f in /app/.env /app/.env.local /app/.env.production; do
    if [ -e "$f" ]; then echo "dotenv in image: $f"; exit 1; fi
  done
  # Pass 39: the worker regenerates its Prisma client AFTER the .env prune, so
  # it needs the pass-38 rewrite too; and the source/config names the web stage
  # refuses must not ride along in the registry-pushed image.
  test -e /app/node_modules/.prisma/client/index.js
  grep -q "\"schemaEnvPath\": null" /app/node_modules/.prisma/client/index.js
  test ! -e /app/app
  test ! -e /app/components
  test ! -e /app/next.config.mjs
  test ! -e /app/proxy.ts
  test ! -e /app/instrumentation.ts
  test ! -e /app/instrumentation-client.ts
  test ! -e /app/sentry.server.config.ts
  test ! -e /app/sentry.edge.config.ts
  test ! -e /app/vitest.config.ts
  test ! -e /app/vitest.setup.ts
  test ! -e /app/playwright.config.ts
  test ! -e /app/prisma/seed.ts
  test ! -e /app/public
  echo "worker image shape OK"
' || { echo "worker image artifact assertion FAILED"; exit 1; }
# Boot the worker image too (pass 33). Its shape was asserted and nothing else:
# the e2e stage below runs `npx tsx scripts/worker.ts` from the repo tree with
# devDependencies present, which is not the artifact operators deploy — the
# image runs the same command from a pruned tree with production dependencies
# only, and no job had ever started it. The schema is already migrated (the web
# smoke above runs migrate deploy). Same gate as ci.yml: the worker's own
# startup line, printed only after both production boot gates pass, and the
# container still alive when it appears.
# rm -f first, like the web smoke: a container left by a killed earlier run
# must not block the name.
docker rm -f pd-ci-worker-smoke >/dev/null 2>&1 || true
docker run -d --name pd-ci-worker-smoke \
  --add-host=host.docker.internal:host-gateway \
  -e DATABASE_URL="postgresql://pixelduo:pixelduo@host.docker.internal:5432/pixelduo_test" \
  -e REDIS_URL="redis://host.docker.internal:6379" \
  -e NEXTAUTH_SECRET="$NEXTAUTH_SECRET" \
  -e STORAGE_DRIVER=local \
  pd-ci-worker >/dev/null
worker_ok=""
for i in $(seq 1 30); do
  if docker logs pd-ci-worker-smoke 2>&1 | grep -q '\[worker\] PixelDuo media worker started'; then worker_ok=1; break; fi
  sleep 2
done
worker_running="$(docker inspect -f '{{.State.Running}}' pd-ci-worker-smoke 2>/dev/null || echo false)"
# Captured BEFORE the container goes away — reading the logs after `docker rm`
# prints nothing, which is exactly the moment this gate most needs to say why.
worker_logs="$(docker logs pd-ci-worker-smoke 2>&1 | tail -30 || true)"
docker rm -f pd-ci-worker-smoke >/dev/null 2>&1 || true
if [ -z "$worker_ok" ] || [ "$worker_running" != "true" ]; then
  echo "worker image boot smoke FAILED — the worker never reached its startup line (running=$worker_running):" >&2
  echo "$worker_logs" >&2
  exit 1
fi
echo "worker image boots against the services and reports started"

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
# tee: the leak scan below reads the PRUNE's own report out of this log to
# prove the build host's .env actually reached the standalone tree (pass 33).
# pipefail is set at the top of this script, so a failing build still fails here.
#
# Plant the same two leaks CI plants (pass 34). The prune's own report is only
# evidence if material REACHED the tree, and on a fresh clone or a container
# that has only ever run this script there is no .env (it exports everything
# itself) and no prisma/dev.db — so the prune correctly reported nothing and
# the gate below exited 1 blaming a healthy artifact. A real .env in the tree
# is real material and must never be overwritten, so plant only when the
# developer has neither; the trap removes the plant on every exit path.
if [ ! -e .env ] && [ ! -e prisma/dev.db ]; then
  printf 'NEXTAUTH_SECRET=ci-planted-not-a-real-secret\nDATABASE_URL=postgresql://planted:planted@127.0.0.1:5432/planted\n' > .env
  printf 'SQLite format 3\000ci-planted' > prisma/dev.db
  PLANTED_ENV=1
fi
npm run build 2>&1 | tee /tmp/pd-ci-build.log

# The artifact that deploys must not carry the build host's secrets. `next
# build` copies .env into .next/standalone unconditionally; the postbuild prune
# is what removes it, and a silent failure here ships NEXTAUTH_SECRET and the
# database URL with the artifact. Same assertion as CI's build job, and likewise
# no -maxdepth (pass 32): the prune walks the whole tree, so a depth limit made
# this blind to a leak the prune DOES reach.
#
# Two ways this could be the vacuous version of itself, both refused (pass 33):
# a missing/unreadable .next/standalone (the `|| true` turned the find's error
# into "clean"), and a run where nothing ever entered the tree — in which case
# an empty find proves nothing about the prune. The tree is required to exist,
# and the prune's own log line is required to name the .env it removed, because
# that line is the only evidence the guard ran against material.
if [ ! -d .next/standalone ]; then
  echo "no .next/standalone tree to scan — the build did not produce the deploy artifact" >&2
  exit 1
fi
LEAKED="$(find .next/standalone \( -name '.env*' -o -name '*.db' -o -name '*.sqlite*' \) -not -path '*/node_modules/*')"
if [ -n "$LEAKED" ]; then
  echo "standalone artifact carries dotenv files:" >&2
  echo "$LEAKED" >&2
  exit 1
fi
PRUNE_LINE="$(grep -m1 '\[prune-standalone\]' /tmp/pd-ci-build.log || true)"
case "$PRUNE_LINE" in
  *"removed "*)
    ;;
  *)
    echo "the prune reported no removals ($PRUNE_LINE) — nothing the scan above looks for ever reached .next/standalone, so it proved nothing" >&2
    exit 1
    ;;
esac
case "$PRUNE_LINE" in
  *standalone/.env*)
    ;;
  *)
    echo "the prune's report does not name .next/standalone/.env — this host's .env never reached the tree:" >&2
    echo "$PRUNE_LINE" >&2
    exit 1
    ;;
esac
# Pass 38: deleting .env is not enough while the tree's generated Prisma client
# READ one — its config resolves ../../../.env against its own directory, so a
# dotenv restored beside the artifact (a pre-prune backup, an rsync of a tree
# built without postbuild, a kept dev file) was live configuration for every
# process that imports the client — the boot gates included — while docs/deploy.md
# said such a file configures nothing. postbuild rewrites those paths to null;
# this asserts the tree really carries the rewrite. CI's build job greps the
# same two strings.
PRISMA_CLIENT=".next/standalone/node_modules/.prisma/client/index.js"
if [ ! -e "$PRISMA_CLIENT" ]; then
  echo "no Prisma client in the standalone tree — the app cannot run from this artifact" >&2
  exit 1
fi
if ! grep -q '"schemaEnvPath": null' "$PRISMA_CLIENT"; then
  echo "the artifact's Prisma client still resolves a schema env path — a .env beside the tree would be live configuration:" >&2
  grep -o '"relativeEnvPaths"[^}]*}' "$PRISMA_CLIENT" >&2 || true
  exit 1
fi
if ! grep -q '"rootEnvPath": null' "$PRISMA_CLIENT"; then
  echo "the artifact's Prisma client still resolves a root env path" >&2
  exit 1
fi
# Pass 39: Next's own loader (BaseServer -> loadEnvConfig) also reads a .env
# placed beside the tree. postbuild prepends the flag that makes @next/env skip
# file population; assert the host tree carries it as well as the image.
if ! grep -q "__NEXT_PROCESSED_ENV" .next/standalone/server.js; then
  echo "the artifact's server.js does not neutralise Next's runtime dotenv loading" >&2
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
  # handed the `rm -rf` below a directory outside /tmp.
  *..*)
    echo "refusing to rm -rf MAIL_DEV_DIR='$MAIL_DEV_DIR' — it must not contain '..'" >&2
    exit 1
    ;;
  # STRICTLY this script's own scratch directory (pass 31). The arms this
  # replaced (`/tmp/*`, `/var/folders/*`, "$PWD"/.tmp*) admitted every path under
  # /tmp — including MAIL_DEV_DIR=/tmp/pd-mail, the value the README's manual dev
  # flow and the CI e2e job export for a DIFFERENT mailer instance — so the guard
  # whose whole purpose was "never delete a directory we do not own" deleted
  # exactly such a directory. The strict pattern is the comment's own rule.
  /tmp/pd-ci-mail|/tmp/pd-ci-mail/*) ;;
  *)
    echo "refusing to rm -rf MAIL_DEV_DIR='$MAIL_DEV_DIR' — unset it (this script owns only /tmp/pd-ci-mail)" >&2
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
# Refuse to start on top of a leftover listener (the trap above is what removes
# this run's own listeners at exit; this is the stale-process guard).
for port in 3100 3101 3109; do
  if [ -n "$(lsof -ti "tcp:$port" 2>/dev/null || true)" ]; then
    echo "port $port is already in use — a leftover server would make every check below pass against ITS build; stop it first" >&2
    exit 1
  fi
done
# -H 127.0.0.1: `next start` without it binds 0.0.0.0 (the CLI's own default),
# i.e. this stack — auto-verifying registrations, mock payments, mock image
# provider, no TLS, no edge, XFF-trusting per-IP limiters — was served to the
# whole LAN for the run's duration. Same loopback pin as dev-restart.sh and the
# compose port mappings; playwright and the health curls all use localhost.
STARTED_PORTS+=(3100)
npx next start -p 3100 -H 127.0.0.1 >/tmp/pd-ci-app.log 2>&1 &
APP_PID=$!
npx tsx scripts/worker.ts >/tmp/pd-ci-worker.log 2>&1 &
WORKER_PID=$!

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
STARTED_PORTS+=(3101)
npx next start -p 3101 -H 127.0.0.1 >/tmp/pd-ci-app-verify.log 2>&1 &
APP2_PID=$!

for i in $(seq 1 30); do
  curl -fsS http://localhost:3101/api/health >/dev/null 2>&1 && break
  sleep 2
done
curl -fsS http://localhost:3101/api/health >/dev/null

PW_BASE_URL="http://localhost:3101" PW_CHANNEL=chrome \
  npx playwright test e2e/verify-email.spec.ts

echo "CI-LOCAL PASSED — pipeline is green locally"
