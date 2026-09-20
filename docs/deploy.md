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
| `PAYMENT_PROVIDER` + 对应密钥 | 必须能构造出 provider | `getPaymentProvider()` 现在也在启动时解析（`assertPaymentProviderUsable()`）：拼错的值、生产下的 `mock`、缺少 `STRIPE_WEBHOOK_SECRET` / Paddle 密钥都会让进程拒绝启动。此前它只在第一次 checkout 或 webhook 时才被调用，于是容器"健康"、每笔支付 500、**每个回调 500**——上游重试数天后停用该回调地址，结果是钱收了、积分没给 |

标记为测试部署（`PAYMENT_ALLOW_MOCK=1`，CI 与 `ci-local.sh` 使用）时，后三项自动豁免——mock 支付本身在生产已被拒绝，该标记即"这不是真实部署"的声明。

### 用户反馈（`/feedback`）

留言会存进 `Feedback` 表（管理台 **feedback** 标签页 = 收件箱），同时把通知邮件发到 `FEEDBACK_TO`（未配置时用代码里的默认运维邮箱）。邮件用纯文本，`Reply-To` 是留言者本人，所以在邮箱里直接回复就是回复用户。

- `FEEDBACK_TO`（可选）：改成客服别名/工单邮箱即可，不需要改代码
- 表单对登录与未登录都开放（登录不上的人也必须能找到你），因此限流是双轴的：每 IP 5 条 / 10 分钟 + 每账号 5 条 / 10 分钟；未登录必须填回复邮箱
- 自动附带的定位信息：套餐、界面语言、来源页面（只取路径，不含 query，避免把重置令牌之类带进邮箱）、User-Agent
- SMTP 故障不会丢留言：先入库再发信，发信失败只记录告警

**发信配置（决定你能否收到通知）**：`SMTP_URL` + `EMAIL_FROM` 必须指向一个真实发信服务，未配置时邮件走 `DevMailer`——**只打印到容器日志，不投递**。可选任一 SMTP：

```bash
# Resend（推荐，域名可控）：先在控制台验证发信域名
SMTP_URL="smtp://resend:<API_KEY>@smtp.resend.com:587"
EMAIL_FROM="PixelDuo <no-reply@你的域名>"
# Amazon SES / SendGrid / Postmark 同理：smtp://用户名:密码@smtp主机:端口
# Gmail 应用专用密码（个人收件箱，需先开两步验证并生成 app password）
SMTP_URL="smtp://你的地址@gmail.com:<app-password>@smtp.gmail.com:587"
```

两点容易踩的坑：

- **发信域名要先验证**：Resend / SES / SendGrid 都要求把 `EMAIL_FROM` 的域名加进控制台并配置 **SPF + DKIM** DNS 记录，否则连接成功但邮件被拒（脚本会直接给出这条提示）；临时可用服务商给的 onboarding 地址当 `EMAIL_FROM`。
- **到了也可能进垃圾箱**：Gmail 对未做 SPF/DKIM/DMARC 的发信方会归入垃圾邮件。所以"收到"要连垃圾箱一起看，长期做法是给发信域名配齐三条记录。
- 生产部署**无法**用"只打印到日志"模式：`assertProductionConfig()` 要求 `SMTP_URL`（或显式 `MAIL_DEV_MODE=1`）。密码重置/验证邮件依赖同一条通道，所以这不是反馈功能单独的需求——生产必须配。

配置后用自托管机或本地任一环境提交一条真实留言，确认 `FEEDBACK_TO` 邮箱收到通知、且直接回复能回到留言者。不接 SMTP 也能用——留言仍在管理台 feedback 标签页里，只是不会推送到邮箱。

**一条命令验证投递**（配置后先跑这个，再谈"用户能不能收到"）：

```bash
SMTP_URL="..." EMAIL_FROM="..." npx tsx scripts/verify-mail.ts
# → transport / from / recipient
# → server response: 250 2.0.0 Ok: queued as …      ← 接收端自己的应答，这才是投递证据
# → [OK] / [FAIL]（失败时给出 535 认证、PBL 黑名单、TLS 端口等具体提示）
```

它以 `--exit-code` 反映成败，可直接当部署门禁；无 `SMTP_URL` 时它主动失败并说明原因，**不会**让你误以为"没报错就是发出去了"。管理台 feedback 标签页在未配置 `SMTP_URL` 时也会显示提示，避免运维以为通知在发。

本地想在无账号的情况下验证发信链路：`node scripts/dev-smtp-sink.mjs 2525 /tmp/pd-smtp-inbox.log &` 后 `SMTP_URL=smtp://127.0.0.1:2525 bash scripts/dev-restart.sh`，提交留言，收到的报文（含信封收件人）写在 `/tmp/pd-smtp-inbox.log`。

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
# 真实响应体只有 ok / service / db / redis / storage / queue.active / time：
# {"ok":true,"service":"pixelduo","db":"up","redis":"up","storage":"up","queue":{"active":false},"time":"..."}
# ok:false 时它仍然返回 200，`curl -f` 不会失败，所以要看 JSON 内容：
curl -sS https://pixelduo.ai/api/health \
  | jq -e '.service == "pixelduo" and .ok and .db == "up" and .redis == "up" and .storage == "up"'
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
- **worker 存活检查**：health 出于反侦察只暴露 `queue.active`（是否正在跑任务），它无法区分"空闲"与"卡死"，也不暴露队列深度/心跳时间。`docker-compose.prod.yml` 里**只有 `web` 定义了 healthcheck**（探 `/api/health`）；worker 没有，也刻意不给：它的镜像是 `node:24-alpine` + 几个 apk 包，没有任何能证明"还在干活"的现成探针，而一个只证明 PID 1 还在的 healthcheck 并不比 `ps` 的 `Up` 多出信息（进程真死了容器就退出、`restart: unless-stopped` 会拉起），却会让人误以为 worker 有健康信号。所以用下面这些**已构建镜像、容器已在跑**的前提下才能真正执行的人工核对：
  ```bash
  docker compose -f docker-compose.prod.yml ps worker               # 应为 Up；worker 没有 healthcheck，STATUS 里不会出现 healthy/unhealthy
  docker compose -f docker-compose.prod.yml top worker              # 容器内进程应看到 npx tsx scripts/worker.ts（及其派生的 node 进程）在跑
  docker inspect --format '{{.State.Status}} restarts={{.RestartCount}}' \
    "$(docker compose -f docker-compose.prod.yml ps -q worker)"     # restarts 一直涨 = 启动即崩（如审核配置缺失，见下）
  docker compose -f docker-compose.prod.yml logs --tail=50 worker   # 应有 "job ... done" 或 "idle…"
  psql "$DATABASE_URL" -c "SELECT status, count(*) FROM \"Job\" WHERE status IN ('queued','running','polling') GROUP BY status"
  ```
  （没有本地 psql 就在托管商的 SQL 控制台跑同一条查询。）`queued` 持续堆积而 worker 日志无输出 = worker 掉线（任务仍持有已预扣的额度，恢复 worker 后会继续跑）
- `IMAGE_MODERATION=1` 时每张图过 vision 审核：命中即拦截 + 自动退款；**审核跑不起来（网关报错/超时/回复无法解析/未解析到 vision 配置）时同样不交付**——任务终态失败并全额退款，输出对象被删除。这是刻意的 fail-closed：否则任何能让审核失败的人都能拿到未过审的图。需要关闭审核就显式设置 `IMAGE_MODERATION=0`（并清空 `IMAGE_NSFW_ENDPOINT`），不要靠"审核坏了"来降级。超大输出会先缩放到 1024px 再审，不再按体积跳过；建议先小流量灰度观察误判率
- **审核开关的取值**：除 `0` 以外任何非空值都视为"要审核"（`true`/`yes` 这类拼写不再等于关闭）。**审核开了却没有解析到 vision 配置时 worker 会直接拒绝启动**（日志 `[fatal] IMAGE_MODERATION asks for an image audit...`，容器反复重启）——这是刻意的：否则每张图都会先生成、被计费、再被丢弃退款，既漏审又烧钱。`docker-compose.prod.yml` 的 `VISION_MODERATION_API_KEY` 默认是空的，上线前必须填（或显式设 `IMAGE_MODERATION=0`）
- **视频不审核**：目前没有任何视频检测器可调，`IMAGE_MODERATION` 只覆盖图片；视频的合规标记只有 UI 角标
- `IMAGE_NSFW_ENDPOINT`（可选，优先级高于 vision 路径）：worker 以 `{"url": "<对象预签名 URL>"}` POST，检测方必须回 `{"flagged": <boolean>}`；其它 2xx 响应体一律视为"审核没跑成"（fail-closed），所以打分格式/错误信封不会被当成"通过"。检测方必须能访问对象存储：`STORAGE_DRIVER=local` 下对象只在站内 `/api/files` 可读，该路径会直接拒绝并让任务失败（而不是假装审过）

### 回滚

保留上一版本镜像 tag（`IMAGE_WEB=pixelduo-web:prev`），`docker compose -f docker-compose.prod.yml up -d` 即可回滚；数据库迁移回滚需人工处理（托管商 PITR）。

## 上线前最后核对（对应 docs/compliance/launch-checklist.md）

- [ ] `NEXTAUTH_URL` / `CADDY_DOMAIN` 为 https 正式域名
- [ ] `PAYMENT_PROVIDER=stripe|paddle` + 对应生产 key/webhook secret（两 Provider 已实现；真实沙箱全流程验证后切生产，**禁止 mock 上生产**）
- [ ] Sentry DSN 生效且收到测试告警
- [ ] 备份恢复演练已在生产环境复跑
- [ ] 日志脱敏抽查（不出现密码/Token/支付原文）
