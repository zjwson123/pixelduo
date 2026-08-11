# PixelDuo 生产部署指南

## 架构形态

生产采用"**托管数据 + 容器应用 + Caddy HTTPS**"：

- **web**（Next.js standalone，仅容器内网 3000 端口）——由 Caddy 对外代理
- **worker**（生图 + 图像审核）、**rollover**（月度结转 + 积分过期）
- **Caddy**：80/443 入口，自动 Let's Encrypt HTTPS
- 数据全部走托管服务：Postgres（Neon/RDS/Supabase）、Redis（Upstash/ElastiCache）、对象存储（Cloudflare R2/AWS S3）
- 监控：Sentry（`SENTRY_DSN`）；备份由托管商提供，自托管时用 `backup` 服务/`scripts/backup.sh`

## 前置条件

1. 一台服务器（≥2C4G，推荐 4C8G；生图是异步任务，worker 需要网络出口到生图 API）
2. 域名（如 pixelduo.ai）DNS A 记录指向服务器 IP
3. 托管服务并准备好连接串：
   - `DATABASE_URL`（Postgres，建议开启自动备份 + PITR）
   - `REDIS_URL`（带密码，如 `rediss://...`）
   - `S3_ENDPOINT`（**公网可达**，否则预签名 URL 打不开）、`S3_BUCKET`、`S3_ACCESS_KEY_ID`、`S3_SECRET_ACCESS_KEY`
4. 生图与审核 Key：`MODELVERSE_IMAGE_API_KEY`、`ARK_IMAGE_API_KEY`、`DEEPSEEK_API_KEY`、`VISION_MODERATION_API_KEY`（无独立 key 时可用 `VISION_MODERATION_BASE_URL` + 同款 ModelVerse key）
5. `NEXTAUTH_SECRET`（`openssl rand -base64 32` 生成）

## 部署步骤

```bash
# 1. 克隆代码并构建镜像（或在 CI 推送镜像后改 IMAGE_WEB/IMAGE_WORKER）
git clone <repo> pixelduo && cd pixelduo
docker compose build web worker rollover

# 2. 配置环境变量（也可用 .env.production 或密钥管理器注入）
export DATABASE_URL="postgresql://..."
export REDIS_URL="rediss://..."
export S3_ENDPOINT="https://<account>.r2.cloudflarestorage.com"
export S3_BUCKET="pixelduo"
export S3_ACCESS_KEY_ID="..."
export S3_SECRET_ACCESS_KEY="..."
export NEXTAUTH_SECRET="..."
export NEXTAUTH_URL="https://pixelduo.ai"
export PAYMENT_PROVIDER="stripe"            # or paddle
export STRIPE_SECRET_KEY="sk_live_..."
export STRIPE_WEBHOOK_SECRET="whsec_..."
# Paddle (Merchant of Record) alternative:
export PADDLE_API_KEY="pdl_live_..."
export PADDLE_ENVIRONMENT="production"
export PADDLE_WEBHOOK_SECRET="..."
export CADDY_DOMAIN="pixelduo.ai"
export MODELVERSE_IMAGE_API_KEY="..."
export ARK_IMAGE_API_KEY="..."
export SENTRY_DSN="https://..."

# 3. 启动
docker compose -f docker-compose.prod.yml up -d

# 4. 验证
curl -fsS https://pixelduo.ai/api/health   # {"ok":true,"db":"up","rateLimiter":"redis"}
```

首次启动会自动申请 Let's Encrypt 证书（需 80 端口可被公网访问）。

## 运维

### 升级

```bash
git pull
docker compose build web worker rollover
docker compose -f docker-compose.prod.yml up -d
```

### 迁移

web/worker 启动前会由 CI/部署流程执行 `npx prisma migrate deploy`（迁移是幂等的）。升级含 schema 变更时先跑迁移再切流量。

### 备份与恢复

- 托管 Postgres：开启自动备份 + PITR，按需 `pg_restore`（恢复演练已通过，见 `progress.md`）
- 自托管 Postgres：`docker compose up -d backup` 每日 dump 到 `./backups/`；手动 `./scripts/backup.sh`
- 恢复：`pg_restore -d $DATABASE_URL backups/pixelduo-<stamp>.dump.gz`

### 限流与审核

- `/api/health` 的 `rateLimiter` 应为 `redis`（多实例全局限流）
- `IMAGE_MODERATION=1` 时每张图过 vision 审核，命中即拦截 + 自动退款；建议先小流量灰度观察误判率

### 回滚

保留上一版本镜像 tag（`IMAGE_WEB=pixelduo-web:prev`），`docker compose -f docker-compose.prod.yml up -d` 即可回滚；数据库迁移回滚需人工处理（托管商 PITR）。

## 上线前最后核对（对应 docs/compliance/launch-checklist.md）

- [ ] `NEXTAUTH_URL` / `CADDY_DOMAIN` 为 https 正式域名
- [ ] `PAYMENT_PROVIDER=stripe|paddle` + 对应生产 key/webhook secret（两 Provider 已实现；真实沙箱全流程验证后切生产，**禁止 mock 上生产**）
- [ ] Sentry DSN 生效且收到测试告警
- [ ] 备份恢复演练已在生产环境复跑
- [ ] 日志脱敏抽查（不出现密码/Token/支付原文）
