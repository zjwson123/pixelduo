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
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
COPY --from=builder /app/prisma ./prisma
EXPOSE 3000
CMD ["node", "server.js"]

# ---------- worker / scripts (full runtime) ----------
FROM node:24-alpine AS worker
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
# CJK fonts so sharp/SVG text (baked "AI 生成" watermark) renders in containers
RUN apk add --no-cache fontconfig font-noto-cjk
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx prisma generate
CMD ["npx", "tsx", "scripts/worker.ts"]
