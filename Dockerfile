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
# `.env*` out of the build context. Untyped/optional — robots.txt and sitemap.xml
# read the same value at REQUEST time instead (lib/site.ts), so an unset arg
# degrades those two rather than the build.
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
# Source-map upload (next.config.mjs). A build secret, so it is an ARG and never
# an ENV: an ENV would be readable in `docker inspect` on every running container
# of the image, long after the build that needed it.
ARG SENTRY_AUTH_TOKEN=""
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx prisma generate && npm run build

# ---------- web (Next standalone) ----------
FROM node:24-alpine AS web
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
COPY --from=builder --chown=node:node /app/public ./public
COPY --from=builder --chown=node:node /app/prisma ./prisma
# Runs AFTER every COPY on purpose: `--from=builder /app/public` would otherwise
# put public/generated back after the prune.
#
# `next build` traces from the whole project root — lib/storage.ts builds a
# cwd-relative path from LOCAL_STORAGE_DIR (default `data/files`) — so the
# standalone output drags in whatever sat next to the source: docs/, tests/,
# e2e/, designs/ (internal notes and past-vulnerability history). It also copies
# the env files it loaded into .next/standalone unconditionally
# (writeStandaloneDirectory), so a build run from a working tree that has a real
# .env bakes NEXTAUTH_SECRET / DATABASE_URL / S3 keys into the image as
# plaintext. data/, backups/ and public/generated are pruned for the same reason
# they are .dockerignore'd: runtime output that must never leave this host.
# `.dockerignore` is the primary defence (it keeps all of the above out of the
# build CONTEXT); this step is belt-and-braces for the copy --standalone already
# made, so the image does not depend on that one file staying correct. Only
# things the running server never reads are pruned — public/templates,
# public/showcase, prisma/, server.js, node_modules and .next all stay.
# perf/ is in both lists because the sprint tooling left a LIVE session cookie
# in perf/bench/session.json (the bench's Playwright storage state) next to raw
# measurements; it is dev tooling, not runtime input.
RUN rm -rf \
      .env .env.* \
      docs tests e2e designs data backups public/generated perf \
      ./*.md docker-compose*.yml Caddyfile Dockerfile \
      ./*.tsbuildinfo
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
COPY --chown=node:node . .
RUN npx prisma generate
# Same prune as the web stage, for the same reason `COPY . .` is unsafe here:
# .dockerignore keeps secrets and runtime data out of the context, but it does
# not cover internal prose. The worker image — the one a registry push or
# `docker save` carries off the host, and the one operators are told to keep old
# tags of — otherwise ships docs/ (the full history of every fixed weakness, plus
# the provider cost/pricing research), docs/compliance/, tests/, e2e/, designs/
# and the root markdown. None of it is read at runtime: the worker needs
# package.json, node_modules, prisma/, lib/ and scripts/ only, and
# prisma/seed.ts's designs/ read is a CI/host-only path.
#
# The compose files and Caddyfile are pruned here for the same reason README.md
# is: they describe the deployment. `.env*` in this list is what protects the
# build host — a compose file that survived into the image is also where a live
# S3 key pasted into an override would be readable by anyone who can `docker
# save` it. perf/ carries the sprint's bench scripts and reports, and
# perf/bench/session.json is a live session cookie — see the web stage's note.
RUN rm -rf \
      .env .env.* \
      docs tests e2e designs data backups public/generated public/showcase perf \
      ./*.md docker-compose*.yml Caddyfile Dockerfile \
      ./*.tsbuildinfo
USER node
CMD ["npx", "tsx", "scripts/worker.ts"]
