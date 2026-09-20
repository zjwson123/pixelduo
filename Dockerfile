# ---------- deps ----------
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ---------- builder ----------
FROM node:24-alpine AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
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
RUN rm -rf \
      .env .env.production .env.local \
      docs tests e2e designs data backups public/generated \
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
RUN rm -rf \
      .env .env.production .env.local \
      docs tests e2e designs data backups public/generated public/showcase \
      ./*.md ./*.tsbuildinfo
USER node
CMD ["npx", "tsx", "scripts/worker.ts"]
