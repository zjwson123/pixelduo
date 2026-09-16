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
5. `NEXTAUTH_SECRET`（`openssl rand -base64 32` 生成）。它给所有会话 JWT 签名：**少于 32 位或仍是占位符（如 `change-me-…`）时生产环境拒绝启动**（`instrumentation.ts`），不要沿用 `.env.example` 里的示例值

### 生产启动自检（任一不满足即**拒绝启动**，进程退出）

`instrumentation.ts` 的 `assertProductionConfig()` 以 `process.exit(1)` 结束进程（此前只抛错，Next 会吞掉异常并继续监听，线上表现是"容器活着但每个动态路由都 500"）：

| 变量 | 要求 | 原因 |
| --- | --- | --- |
| `NEXTAUTH_SECRET` | ≥32 位且非占位符 | 泄露即可离线爆破并伪造任意账号（含管理员）的会话 |
| `NEXTAUTH_URL` | **https://** | next-auth 仅依此判断是否给会话 Cookie 加 `Secure`；http 时 Cookie 明文可被截获，且邮件链接指向错误域名 |
| `SMTP_URL` | 必填（或 `MAIL_DEV_MODE=1`） | 缺省时邮件走 stdout，密码重置链接（等于账号接管凭据）会写进容器日志 |
| `EMAIL_VERIFY_AUTO` | 生产禁用 | 自动验证注册并发放注册奖励 = 无限量带额度的已验证账号 |

标记为测试部署（`PAYMENT_ALLOW_MOCK=1`，CI 与 `ci-local.sh` 使用）时，后三项自动豁免——mock 支付本身在生产已被拒绝，该标记即"这不是真实部署"的声明。

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
curl -fsS https://pixelduo.ai/api/health   # {"ok":true,"db":"up","redis":"up","storage":"up","queue":{"active":false}}
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
- **对象存储（用户图片）**：托管 R2/S3 开启**版本控制 + 跨区域复制**（DR 首选）；自托管 MinIO 用 `backup-objects` 服务每日镜像到 `./backups/objects/`（保留 7 份，`BACKUP_TARGET_*` 可同步第二桶异地）；恢复演练 `./scripts/restore-objects.sh <stamp> <scratch-bucket>`

### 限流与审核

- `/api/health` 的 `redis` 应为 `up`（多实例全局限流），且 `db`/`redis`/`storage` 均为 `up`
- **worker 存活检查**：health 出于反侦察只暴露 `queue.active`（是否正在跑任务），它无法区分"空闲"与"卡死"，也不暴露队列深度/心跳时间。要判断 worker 掉线，用容器状态与队列：
  ```bash
  docker compose -f docker-compose.prod.yml ps worker          # 应在 Up（含 healthcheck）
  docker compose -f docker-compose.prod.yml logs --tail=50 worker   # 应有 "job ... done" 或 "idle…"
  psql "$DATABASE_URL" -c "SELECT status, count(*) FROM \"Job\" WHERE status IN ('queued','running','polling') GROUP BY status"
  ```
  `queued` 持续堆积而 worker 日志无输出 = worker 掉线（任务仍持有已预扣的额度，恢复 worker 后会继续跑）
- `IMAGE_MODERATION=1` 时每张图过 vision 审核：命中即拦截 + 自动退款；**审核跑不起来（网关报错/超时/回复无法解析/未解析到 vision 配置）时同样不交付**——任务终态失败并全额退款，输出对象被删除。这是刻意的 fail-closed：否则任何能让审核失败的人都能拿到未过审的图。需要关闭审核就显式设置 `IMAGE_MODERATION=0`（并清空 `IMAGE_NSFW_ENDPOINT`），不要靠"审核坏了"来降级。超大输出会先缩放到 1024px 再审，不再按体积跳过；建议先小流量灰度观察误判率

### 回滚

保留上一版本镜像 tag（`IMAGE_WEB=pixelduo-web:prev`），`docker compose -f docker-compose.prod.yml up -d` 即可回滚；数据库迁移回滚需人工处理（托管商 PITR）。

## 上线前最后核对（对应 docs/compliance/launch-checklist.md）

- [ ] `NEXTAUTH_URL` / `CADDY_DOMAIN` 为 https 正式域名
- [ ] `PAYMENT_PROVIDER=stripe|paddle` + 对应生产 key/webhook secret（两 Provider 已实现；真实沙箱全流程验证后切生产，**禁止 mock 上生产**）
- [ ] Sentry DSN 生效且收到测试告警
- [ ] 备份恢复演练已在生产环境复跑
- [ ] 日志脱敏抽查（不出现密码/Token/支付原文）
