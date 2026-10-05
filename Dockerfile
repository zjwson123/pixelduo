# ---------- deps ----------
FROM node:24-alpine AS deps
WORKDIR /app
# .npmrc MUST be copied with the manifests: it is what makes this lockfile
# installable (legacy-peer-deps=true — see the file for the next-auth/nodemailer
# peer mismatch it resolves), and the lockfile was generated WITH it, so npm ci
# without it re-derives the tree, finds webpack's subtree missing from the lock
# and refuses to install. Omitting this line broke EVERY image build of this
# repository for three weeks — nothing caught it because no CI job builds the
# image and host-side `npm ci` always has .npmrc sitting next to it. `ci.yml`'s
# docker job builds the deps stage now, so the next omission fails in CI.
COPY package.json package-lock.json .npmrc ./
RUN npm ci

# ---------- builder ----------
FROM node:24-alpine AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
# The site origin is read at BUILD time by everything Next prerenders: the
# OpenGraph/twitter tags' metadataBase (app/layout.tsx) is baked into the HTML of
# every static page. Without it `next build` writes the http://localhost:3000
# fallback, so a deployment served share previews pointing at the operator's own
# machine. It can only arrive as a build ARG: `.dockerignore` deliberately keeps
# `.env*` out of the build context.
#
# REQUIRED in practice, and the empty default is what makes that loud: the /login
# prerender imports next-auth/react, which builds `new URL(NEXTAUTH_URL)`, so a
# build with no argument fails with `TypeError: Invalid URL` instead of shipping
# an image whose share previews point at localhost. (Pass 19's bug was the silent
# version of this; pass 27 discovered the loud one when the pipeline started
# building this stage — `docker build --target web .` without the arg fails.)
# The compose files pass it from the same variable their runtime anchors require;
# the pipeline passes it explicitly.
ARG NEXTAUTH_URL=""
ENV NEXTAUTH_URL=$NEXTAUTH_URL
# The browser-side Sentry DSN is a BUILD-time value too (instrumentation-client.ts
# is compiled into the client bundle; a runtime env var is far too late). There
# was no ARG for it and `.dockerignore` keeps `.env*` out of the context, so it
# had no path into a container build at all: every containerised deployment ran
# without client error reporting while the server side reported normally.
ARG NEXT_PUBLIC_SENTRY_DSN=""
ENV NEXT_PUBLIC_SENTRY_DSN=$NEXT_PUBLIC_SENTRY_DSN
ARG NEXT_PUBLIC_SENTRY_ENVIRONMENT=""
ENV NEXT_PUBLIC_SENTRY_ENVIRONMENT=$NEXT_PUBLIC_SENTRY_ENVIRONMENT
ARG NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE=""
ENV NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE=$NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE
# NOTE (source maps): there is deliberately no SENTRY_AUTH_TOKEN build argument
# here. An ARG is NOT a secret — the value is recorded verbatim in the image's
# history (`docker history --no-trunc`) and in every `docker save` / registry
# tarball, which is the opposite of what this repository's install docs tell
# operators to keep around. It was also inert: next.config.mjs gates the Sentry
# wrapper on SENTRY_DSN, which no build in this file sets, so nothing was ever
# uploaded and the only thing the ARG achieved was putting a live org token on
# the image. Symbolication needs a BuildKit secret mount
# (`RUN --mount=type=secret,id=sentry_auth_token …`) plus a build-time DSN;
# until that is wired, an image build produces no source maps, and the
# `sourcemaps: { disable: !process.env.SENTRY_AUTH_TOKEN }` gate in
# next.config.mjs keeps a NON-Docker build (where both are in the environment)
# from shipping the original TypeScript instead.
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx prisma generate && npm run build

# ---------- web (Next standalone) ----------
FROM node:24-alpine AS web
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
# COPY and PRUNE in ONE layer, deliberately — this is what makes the prune real.
# A `COPY …` followed by `RUN rm -rf …` removes the files from the CONTAINER but
# not from the image: the copy layer is still there, and `docker save`, a
# registry pull or an old tag (`image-gen-web:prev`, which docs/server-setup.md
# tells operators to keep) hands it over intact. Verified against this file: with
# the two-layer shape, a planted .env and docs/ came out of the exported layer
# even though `docker run … ls` did not show them; with the bind-mount copy
# below, they appear in NO layer at all. The mount is read-only and still
# filtered by .dockerignore (a planted .env never entered it).
#
# What it keeps out, and why it matters here: `next build` traces from the whole
# project root — lib/storage.ts builds a cwd-relative path from
# LOCAL_STORAGE_DIR (default `data/files`) — so the standalone output drags in
# whatever sat next to the source: docs/, tests/, e2e/, designs/ (internal notes
# and past-vulnerability history). It also copies the env files it loaded into
# .next/standalone unconditionally (writeStandaloneDirectory), so a build run
# from a working tree that has a real .env bakes NEXTAUTH_SECRET / DATABASE_URL /
# S3 keys into the image as plaintext. data/, backups/ and public/generated are
# removed for the same reason they are .dockerignore'd: runtime output that must
# never leave this host. `.dockerignore` is the primary defence; this is
# belt-and-braces so the image does not depend on that one file staying correct.
# Only things the running server never reads are removed — public/templates,
# public/showcase, prisma/, server.js, node_modules and .next all stay. perf/ is
# in both lists because the sprint tooling left a LIVE session cookie in
# perf/bench/session.json (the bench's Playwright storage state) next to raw
# measurements; it is dev tooling, not runtime input.
#
# chown -R at the end because a bind-mount copy brings the builder stage's
# root:root along; the app runs as `node` (see USER below).
#
# The `/.` suffix on the public/ and prisma/ copies is load-bearing: the
# standalone tree already contains both directories (Next traces them), and
# `cp -a SRC DST` with DST already existing copies SRC *into* it — producing
# public/public and prisma/prisma, ~13 MB of duplicated layer content plus a
# second URL space where the landing assets resolve again. Docker's `COPY`
# merged directory contents, which is what the pre-pass25 shape did; `SRC/.`
# restores exactly that, and it also creates DST when a future standalone tree
# does NOT trace the directory, so both shapes stay correct.
RUN --mount=type=bind,from=builder,source=/app,target=/b \
    cp -a /b/.next/standalone/. ./ \
 && mkdir -p ./.next \
 && cp -a /b/.next/static ./.next/static \
 && cp -a /b/public/. ./public \
 && cp -a /b/prisma/. ./prisma \
 && rm -rf \
      .env .env.* \
      docs tests e2e designs data backups public/generated perf \
      ./*.md docker-compose*.yml Caddyfile Dockerfile \
      *.db *.db-journal prisma/*.db prisma/*.db-journal \
      ./*.tsbuildinfo \
 && chown -R node:node /app
# Never run as root: a compromise (sharp/libvips, a dependency) must not get
# uid 0 inside the container.
USER node
EXPOSE 3000
CMD ["node", "server.js"]

# ---------- worker / scripts (full runtime) ----------
FROM node:24-alpine AS worker
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
# CJK fonts so sharp/SVG text (baked "AI 生成" watermark) renders in containers
RUN apk add --no-cache fontconfig font-noto-cjk ffmpeg
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
# Same single-layer rule as the web stage: `COPY . .` + a separate `RUN rm -rf`
# leaves everything the prune "removed" inside the copy layer, which is exactly
# the artifact a registry push or `docker save` carries off the host. The bind
# mount is the build context, filtered by .dockerignore.
RUN --mount=type=bind,source=.,target=/ctx \
    cp -a /ctx/. /app/ \
 && rm -rf \
      .env .env.* \
      docs tests e2e designs data backups public/generated public/showcase perf \
      ./*.md docker-compose*.yml Caddyfile Dockerfile \
      *.db *.db-journal prisma/*.db prisma/*.db-journal \
      ./*.tsbuildinfo \
 && chown -R node:node /app
RUN npx prisma generate
# Why the worker image is the one that matters most: it is what a registry push
# or `docker save` carries off the host, and it is what operators are told to
# keep old tags of. Without the prune above it ships docs/ (the full history of
# every fixed weakness, plus the provider cost/pricing research),
# docs/compliance/, tests/, e2e/, designs/ and the root markdown. None of it is
# read at runtime: the worker needs package.json, node_modules, prisma/, lib/
# and scripts/ only, and prisma/seed.ts's designs/ read is a CI/host-only path.
# The compose files and Caddyfile go for the same reason README.md does — they
# describe the deployment — and `.env*` in the list is what protects the build
# host, since a compose file that survived into the image is also where a live
# S3 key pasted into an override would be readable. perf/ carries the sprint's
# bench scripts and reports, and perf/bench/session.json is a live session
# cookie — see the web stage's note.
USER node
CMD ["npx", "tsx", "scripts/worker.ts"]
