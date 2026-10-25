# PixelDuo — MVP（已过 P0 商用化改造）

双引擎 AI 文生图工作台：**GPT Image 2 × Seedream 5** 自由切换/对比，生成前透明计费，DeepSeek Prompt 助手，模板库、画廊、账本与积分/订阅体系。当前为 **免费 Beta（支付壳子）**。

配套文档：
- 产品大纲：[PRODUCT_OUTLINE.md](PRODUCT_OUTLINE.md)（v0.6）
- PRD：[docs/plans/2026-08-11-pixelduo-prd.md](docs/plans/2026-08-11-pixelduo-prd.md)
- 设计原型：[designs/pixelduo/](designs/pixelduo/)
- 黑暗测试：[docs/archive/research/darktest/report.md](docs/archive/research/darktest/report.md)
- 合规：[docs/compliance/](docs/compliance/)

## 技术栈

- Next.js 16（App Router）+ React 19 + TypeScript
- **Postgres 16**（Docker Compose 本地实例；生产可换 Neon/Supabase/RDS）+ Prisma 6 迁移
- 数据库任务队列（`jobs` 表 + worker），上游 `ImageProvider` 抽象（ModelVerse gpt-image-2 / 火山方舟 doubao-seedream-5-0-260128）
- **积分过期体系**：`CreditGrant`（充值包 12 个月有效、订阅配额到期失效、免费积分永不过期且优先消耗）；消费 FIFO + 行锁，失败退款精确归还原 grant；**订阅到期自动降级 free**（rollover 任务），**未用完配额 30% 在续费时结转至新周期**（仅次月有效）
- **到期提醒**：付费积分到期前 7/3/1 天自动发提醒邮件（`lib/reminder.ts` + rollover 容器每日执行，按 grant 去重，发送失败告警不阻塞任务）
- **到期横幅**：工作台按用户展示"X 积分将于 N 天后过期"（`GET /api/credits/expiring`，14 天窗口，仅付费来源），配合到期邮件双触达
- **订单收据**：支付 webhook 履约成功后自动发收据邮件（商品/金额/到账积分，重复 webhook 不重复发送，投递失败仅告警不回滚支付）
- **退款通知**：退款 webhook 处理成功后自动发退款邮件（商品/金额），与积分扣回同一闭环
- **品牌化 HTML 邮件**：验证/重置/收据/退款/到期提醒全部带内联样式 HTML 模板（`lib/mail-html.ts`，用户内容转义），文本版同步保留
- **SEO**：全局 metadata（OpenGraph/Twitter）、robots.txt（屏蔽工作台/API/账号区）、sitemap.xml
- **管理后台**：`/admin`（管理员专属）——用户搜索/升迁/删除、积分调整（补偿发 ADMIN 免费积分 / FIFO 回收，账本留痕）、订单列表、图片审核删除；提权：`npx tsx scripts/promote-admin.ts <email>`
- **公开 API**：`POST /api/v1/images/generations`（Bearer `pd_live_…` Key 鉴权、按积分计费、每 Key 20 次/分钟限流、同一套安全审核与队列）；Key 管理在 `/account/api`，文档见 [docs/api.md](docs/api.md)
- **限流规范**：429 响应带 `Retry-After` + `RateLimit-Limit`/`RateLimit-Remaining`
- **上线就绪**：本地复刻 CI 管道 `./scripts/ci-local.sh`（generate/migrate → tsc → 单测 → 构建 → e2e，`CI-LOCAL PASSED`）；发布运行手册 [docs/release.md](docs/release.md)（env 清单/冒烟命令/监控/回滚）
- **双语落地页**：首页 EN/中文 一键切换（`components/landing.tsx`，导航/卖点/功能/价格/页脚全量翻译，语言偏好存 localStorage）
- **落地页 FAQ**：计费/积分有效期/退款/内容安全/API/图片归属六问（双语折叠卡片）；品牌化 404/500 页（跟随语言偏好）
- **内容安全**：前置关键词过滤 + 后置 vision 模型图像审核（`IMAGE_MODERATION=1`，默认 gpt-5.6-luna，命中即拦截 + 自动退款 + 删图）
- **AI 标识**：免费档 gpt-image-2 图片交付前烘焙 "PixelDuo · AI 生成" 水印（sharp，worker 容器含 Noto CJK 字体）
- NextAuth v4（邮箱+密码 + **OAuth**，JWT 会话）、bcrypt；**邮箱验证 + 密码找回**（单次令牌存 SHA-256 哈希，24h/1h 过期；注册送 30 积分改为验证后发放，未验证账号禁止生图/签到/下单——防薅羊毛）；**登录防爆破**（Redis 按账号 10 次失败/15 分钟锁定）；**会话吊销**（`User.sessionVersion`，重置密码或 `POST /api/auth/revoke-sessions` 后旧 JWT 全部失效）；**TOTP 双因素认证**（otplib + QR，10 个一次性备用码，两步登录，部分会话被 API/页面级拦截，5 分钟单次预认证票据换真会话）；邮件走 `lib/mail.ts`：未配 `SMTP_URL` 时开发模式打印到服务日志，生产接 SES/SendGrid/Resend 等 SMTP
- 支付壳子：`PaymentProvider` 接口 + MockProvider / **Stripe** / **Paddle**（支付宝/微信待主体接入）
- **存储抽象**：`STORAGE_DRIVER=local`（私有目录 + 鉴权路由）或 `s3`（MinIO/R2/S3 + 预签名 URL）
- **限流**：路由级权威限制走 **Redis 全局计数**（`REDIS_URL`，生成 20/min、注册 10/h、结账 10/min、助手 30/min；无 Redis 自动回退单机内存）；中间件内存粗筛（auth 40/min、API 300/min per IP —— 已登录请求按账号分桶，不再和同 IP 上未登录流量抢配额）
- **Worker 健壮性**：指数退避重试（默认 3 次）、心跳、卡死恢复、终态失败 = 死信 + 退款
- **监控告警**：Sentry（`@sentry/nextjs`），DSN 未配置时 no-op；API 500 自动上报（业务性错误过滤），worker/cron 异常带上下文上报
- **备份**：compose `backup` 服务每日 pg_dump（`-Fc` 自定义格式）到 `./backups/`，保留 14 份；`backup-objects` 服务每日把用户图片镜像到 `./backups/objects/`（保留 N 份，可配第二桶异地备份）；恢复演练脚本 `scripts/restore-objects.sh`；手动备份 `./scripts/backup.sh` / `./scripts/backup-objects.sh`
- **支付**：`PaymentProvider` 抽象 + **Stripe Checkout** 与 **Paddle Billing** 均已实现（沙箱/生产同一代码，webhook 验签 + eventId 幂等）；`PAYMENT_PROVIDER=stripe|paddle` + 对应 key/whsec 即启用，未配置时为 mock 壳
- **退款闭环**：支付退款事件标记订单 refunded 并**扣回该订单未消耗的积分**（`revokeOrderCreditsTx`）；webhook 原文落库前做 **PII 脱敏**（GDPR/PIPL）
- 订单历史：`GET /api/orders`（最近 50 笔）；本地模拟签名 webhook：`npx tsx scripts/test-webhook.ts --create-order <email> <credits>` / `--refund <orderId>`
- 工作台 Orders 页签：购买历史 + 支付状态徽标（截图见 designs/pixelduo/preview/orders-tab.png）
- **安全头**：CSP / HSTS / nosniff / X-Frame / Referrer / Permissions-Policy，`poweredByHeader: false`
- **部署**：Dockerfile（web standalone + worker 双目标）、docker-compose 全栈、GitHub Actions CI

## 快速开始

```bash
npm install
docker compose up -d db storage        # Postgres + MinIO
npm run db:migrate                     # 应用迁移（dev）
npm run db:seed                        # 160 条模板 + 素材
npm run dev                            # http://localhost:3000
```

如需全局限流，先起 Redis：`docker compose up -d redis`，并在启动 web 前设置 `REDIS_URL=redis://localhost:6379`（compose 全栈默认已注入）。

另开一个终端启动生图 worker：

```bash
npm run worker
```

到期降级（建议 cron 每日执行，先于过期清扫）：`npm run rollover`
积分过期清扫（建议 cron 每日执行）：`npx tsx scripts/expire.ts`（compose 的 rollover 容器已内置）
到期提醒（建议 cron 每日执行）：`npx tsx scripts/remind.ts`（compose 的 rollover 容器已内置）

### 邮箱验证 / 密码找回

- 本地无 SMTP 时，验证/重置邮件打印到服务器日志（`[mail:dev]`），点链接即可
- 验证页要**同时**输入注册时设置的密码：邮件链接证明"你有邮箱"，密码证明"账号是你注册的"。注册接口不校验邮箱归属，攻击者可以拿别人的邮箱预注册并设一个自己知道的密码——只凭链接就能激活的话，之后对方用 Google 登录会直接进到攻击者的账号里（账号劫持）。忘记密码时走"重置密码"即可换掉那把密码
- 生产设置 `SMTP_URL` 与 `EMAIL_FROM`：一条命令配置并验证——`read -s SMTP_CREDENTIAL; export SMTP_CREDENTIAL; npx tsx scripts/setup-mail.ts aliyun no-reply@域名`（凭据走环境变量，别放命令行——argv 运行期可被本机其他用户 `ps` 看到并进 shell 历史）（也支持 `qq`/`163`/`resend`/`sendgrid`/`postmark`/`ses`/`gmail`/`local`；不带参数运行会列出全部）。它会写 `.env`（留备份、只改这两个键）并立刻打印接收端应答；脚本打印的连接串一律打码（只留方案/主机/端口 + 长度提示），可以放心贴进工单或群聊
- 用户反馈的收件箱是 `FEEDBACK_TO`，**生产必须显式设置**：代码里的兜底地址是开发者的个人邮箱，生产运行时拒绝使用它——未设置就不发通知邮件、只记一条失败原因（管理台 feedback 标签页可见），留言本身照旧入库。改它不需要动代码
- 测试/CI 用 `EMAIL_VERIFY_AUTO=1` 让注册自动验证（e2e 默认路径，跳过上面的密码步骤）；本地跑验证 UX 全流程：

```bash
EMAIL_VERIFY_AUTO=0 MAIL_DEV_DIR=/tmp/pd-mail npx next dev -p 3100   # 另开终端跑 worker
MAIL_DEV_DIR=/tmp/pd-mail npx playwright test e2e/verify-email.spec.ts
```

### 双因素认证（2FA）

- 工作台右上角 **Security** → `/account/security`：扫码（TOTP QR）或手动输入密钥启用，启用时生成 10 个一次性备用码（仅展示一次）
- 登录时密码正确后进入第二步输 6 位码（或备用码）；**未完成 2FA 的部分会话**无法访问任何受保护 API/页面
- 禁用需输入密码 + 当前 6 位码（备用码不可用于禁用，防止被盗码关闭保护）

### OAuth 登录（Google / GitHub）

- 设置 `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`（或 GitHub 对应变量）后，登录/注册页自动出现 "Continue with Google/GitHub" 按钮
- OAuth 首次登录自动建号（邮箱视为已验证并发放 30 积分）；**开启 2FA 的账号不能走 OAuth**（必须用密码登录，避免绕过第二因子），登录页会提示

### 上游模型 Key

优先级：环境变量（`MODELVERSE_IMAGE_API_KEY` / `ARK_IMAGE_API_KEY` / `DEEPSEEK_API_KEY`）→ 本机 `~/.cc-proxy/config.json`。没有 key 时用 `MOCK_IMAGE_PROVIDER=1` 跑 mock。

### 存储

- 默认 `local`：图片存 `data/files/`（gitignore），经 **鉴权路由** `/api/files/...` 访问（未登录 401，仅本人可见）
- 生产推荐 `s3`：对接 MinIO / Cloudflare R2 / AWS S3，接口返回预签名 URL；docker-compose 已内置 MinIO

### 真实生图（本地 Docker）

compose 的 web/worker 容器读不到本机 `~/.cc-proxy/config.json`，compose 已把该文件挂载进容器（可用 `CC_PROXY_CONFIG` 覆盖路径）。生产环境改为注入环境变量：

```bash
STORAGE_DRIVER=s3 docker compose up -d --build   # 真实模型；无 key 时 MOCK_IMAGE_PROVIDER=1 跑 mock
```

### 监控（Sentry，可选）

设置 `SENTRY_DSN` 后自动激活（API 500 上报 + worker/cron 异常），未设置时完全关闭：

```bash
SENTRY_DSN="https://xxxx@o000000.ingest.sentry.io/0000000" STORAGE_DRIVER=s3 docker compose up -d
```

### 备份与恢复

```bash
./scripts/backup.sh                          # pg_dump → backups/，保留最近 14 份
gunzip -c backups/<file>.sql.gz | docker exec -i pixelduo-db psql -U pixelduo -d pixelduo
```

图片对象备份（自托管 MinIO/S3 时使用；托管对象存储建议直接开版本控制 + 跨区域复制）：

```bash
# 手动快照（宿主运行时把 endpoint 指到 host.docker.internal）
BACKUP_S3_ENDPOINT=http://host.docker.internal:9000 \
BACKUP_S3_ACCESS_KEY_ID=pixelduo BACKUP_S3_SECRET_ACCESS_KEY=pixelduo-secret \
BACKUP_S3_BUCKET=pixelduo ./scripts/backup-objects.sh

# 恢复演练：把某个快照恢复到 scratch 桶并校验对象数（演练后删除 scratch 桶）
# RESTORE_DRILL_CONFIRM=1 是必须的：脚本默认 dry run（打印将要写入的内容后以 1 退出）
BACKUP_S3_ENDPOINT=http://host.docker.internal:9000 \
BACKUP_S3_ACCESS_KEY_ID=pixelduo BACKUP_S3_SECRET_ACCESS_KEY=pixelduo-secret \
RESTORE_DRILL_CONFIRM=1 ./scripts/restore-objects.sh <stamp> pixelduo-restore-test
```

compose 全栈默认带 `backup-objects` 服务（每日镜像 + 保留 7 份；配 `BACKUP_TARGET_*` 可同步到第二桶异地）。

### 健康检查

`GET /api/health` 返回 `ok` / `service` / `db` / `redis` / `storage` / `queue.active`（仅"有没有在跑的任务"；队列深度与 worker 心跳属侦察信息，已刻意不暴露）/ `time`，任一关键依赖异常时 `ok:false` **且 HTTP 状态码为 503**（关键依赖全绿才是 200），所以 `curl -f` 判得出来，探活也可以直接读 JSON（可复制的冒烟命令见 [docs/release.md](docs/release.md)）。

### 本地全栈（Docker Compose）

> **这不是生产部署。** 该文件（`docker-compose.yml`）默认 `PAYMENT_ALLOW_MOCK=1`、`MAIL_DEV_MODE=1`、`PAYMENT_PROVIDER=mock`、`NEXTAUTH_URL=http://localhost:3000` —— 前两项正是**关闭生产启动断言**的开关（见 `instrumentation.ts`），并且在 mock 支付下 `/api/checkout` 会直接给任意访问者发积分。生产部署见下方「生产部署」与 [docs/deploy.md](docs/deploy.md)（`docker-compose.prod.yml` + Caddy 自动 HTTPS）。

```bash
docker compose up -d --build        # migrate → web(3000) + worker + rollover + db + storage
curl http://localhost:3000/api/health
```

注意：

- **存储驱动**：compose 固定 `STORAGE_DRIVER=s3`，**不可用 `.env` 覆盖** —— 容器里的 `local` 是每个容器自己的可写层（worker 写、web 读不到，交付的图片全部 404，`compose down` 还会删掉），所以这里不做成开关。宿主机直接 `npm run dev` 时才用 `local`
- **预签名 URL 的 endpoint**：compose 内部用 `http://storage:9000`，容器间可达；生产环境需把 `S3_ENDPOINT` 配成公网可达地址（如 R2/S3 的公网 endpoint 或 MinIO 反代域名），否则浏览器打不开图片
- **生图 Key**：compose 会把 `~/.cc-proxy/config.json` 挂进 web/worker（本机开发用）；其它机器上没有这个文件，需要通过环境变量注入 `MODELVERSE_IMAGE_API_KEY` / `ARK_IMAGE_API_KEY` / `DEEPSEEK_API_KEY`（三个名字 compose 都已转发，见 docker-compose.yml 的 appenv）；没有 key 时 `MOCK_IMAGE_PROVIDER=1 docker compose up -d` 跑 mock

### 本地开发注意

- 工作台路由为 **`/studio`**（未登录跳 `/login`）；`/register`、`/login` 为公开页
- 若在 Docker 构建后本地 `tsx`/`vitest` 报 esbuild 或 Prisma 引擎的平台错误（Linux 二进制混入 macOS 的 `node_modules`），执行 `npx prisma generate` 并按需 `npm ci` 恢复本机平台依赖
- **不要在开发服务器运行时执行 `npm run build` / `./scripts/ci-local.sh`**：构建会重写 `.next`，而正在跑的 `next start` 内存里仍是旧的 route 模块 —— 两者混用会让**每个页面都渲染错误边界（"出了点问题"）**，而服务照旧返回 200，看起来像代码回归。构建后重启即可；一条命令搞定（含本地 MinIO 凭据与生产模式启动断言所需的 `PAYMENT_ALLOW_MOCK=1`）：

  ```bash
  bash scripts/dev-restart.sh     # 重启 :3000 上的 app + worker，并校验 health/页面
  ```
- **邮件**：本地默认走 `DevMailer`——邮件（含验证/重置链接）打印到 `/tmp/pd-dev-app.log`，不投递。要验证真实发信链路又不想申请账号，用仓库里的 SMTP 接收器：`node scripts/dev-smtp-sink.mjs 2525 /tmp/pd-smtp-inbox.log &` 然后 `SMTP_URL=smtp://127.0.0.1:2525 bash scripts/dev-restart.sh`，收到的完整报文（信封收件人 + 报文头）写在 `/tmp/pd-smtp-inbox.log`。生产发信配置见 [docs/deploy.md](docs/deploy.md)（`SMTP_URL` / `EMAIL_FROM` / `FEEDBACK_TO`）

CI（`.github/workflows/ci.yml`）：Postgres 服务容器下跑单测、构建、e2e。

### 生产部署

见 [docs/deploy.md](docs/deploy.md)：`Caddyfile`（自动 HTTPS）+ `docker-compose.prod.yml`（托管 Postgres/Redis/S3 + Caddy 入口），本地已做生产模式冒烟验证。

### 合规与数据权

- 文档：[ToS](docs/compliance/terms.md) · [Privacy/GDPR](docs/compliance/privacy.md) · [上线前清单](docs/compliance/launch-checklist.md)
- 站内合规页：[/terms](/terms) · [/privacy](/privacy)（landing footer 与登录/注册页均已挂链）
- 数据导出/删除：`POST /api/account/export`、`POST /api/account/delete`（body：`{"confirm":true,"password":"<当前密码>"}`；开启 2FA 的账号还需 `token`（TOTP）或 `backupCode`）

## 测试

```bash
npm test                 # 单元测试（Postgres 测试库：成本/账本/队列重试/结转/支付/脱敏/账号/OAuth/2FA/管理/API Key/邮件模板/到期提醒/收据/退款，599 例）
npm run test:e2e         # 端到端（见下）
```

端到端：

```bash
docker compose up -d db
DATABASE_URL="postgresql://pixelduo:pixelduo@localhost:5432/pixelduo_test" npx prisma migrate deploy
DATABASE_URL="postgresql://pixelduo:pixelduo@localhost:5432/pixelduo_test" npx tsx prisma/seed.ts
DATABASE_URL="postgresql://pixelduo:pixelduo@localhost:5432/pixelduo_test" MOCK_IMAGE_PROVIDER=1 EMAIL_VERIFY_AUTO=1 npx next dev -p 3100
DATABASE_URL="postgresql://pixelduo:pixelduo@localhost:5432/pixelduo_test" MOCK_IMAGE_PROVIDER=1 npx tsx scripts/worker.ts
PW_CHANNEL=chrome npx playwright test   # 本地用系统 Chrome；CI 用自带 chromium
```

## MVP 范围与已知边界

- 支付主体/备案仍为壳子：Stripe/Paddle Provider 已实现，真实沙箱全流程 + 生产 key 待申请；支付宝/微信待国内主体
- 邮箱验证 + 找回密码 + 登录防爆破 + 会话吊销 + **TOTP 2FA**（含备用码）+ **OAuth（Google/GitHub，配置即启用）** 已上线
- 管理后台已上线（`/admin`，管理员角色 + ADMIN 账本闭环 + **feedback 留言收件箱**）
- 反馈通知两条通道：邮件（`SMTP_URL` + `FEEDBACK_TO`，见 docs/deploy.md）与**飞书/企微/钉钉群机器人**（`FEEDBACK_WEBHOOK_URL`，无需域名与 SPF，大陆主机最省事，配好用 `npx tsx scripts/verify-webhook.ts` 一条命令验证）；都未配置时留言仍完整保留在管理台收件箱，且管理台会显示哪个通道可用
- **用户反馈已上线**（`/feedback`，入口在首页页脚与工作台顶栏）：登录/未登录都能提交，分类 + 正文 + 回复邮箱；通知邮件发到 `FEEDBACK_TO`（生产必填，见上），`Reply-To` 是留言者，邮箱里直接回复即回复用户；限流双轴（每 IP / 每账号 5 条 / 10 分钟）+ **全局出站通知上限**（`FEEDBACK_NOTIFY_LIMIT`，默认 60 条/小时，超限只停通知、留言照旧入库），完全相同的重复提交 10 分钟内只通知一次；管理台 feedback 标签页分页显示 `N–M of 总数`（每页 50 条，可翻页），可查看/标记已处理，登录状态下提交的留言随账号一并删除（见 [docs/deploy.md](docs/deploy.md)）
- **公开 API 已上线**（`/api/v1/images/generations` + Key 管理 + 文档）；OAuth/支付等外部凭据就绪即启用
- 图片对象备份：自托管已有 `backup-objects` 每日镜像 + 恢复演练；生产托管对象存储仍需开版本控制/跨区域复制
- 内容安全：前置关键词过滤 + 后置 vision 审核（`IMAGE_MODERATION=1`，命中即拦截/退款/删图）
- 水印：Seedream 图自带"AI生成"合规标识；免费档 gpt/wan 图交付前烘焙 "PixelDuo · AI 生成"；**视频免费档目前只有 UI 标识、片内无水印**（产品决定，见"已知边界"）
- 限流：Redis 全局 + 中间件内存粗筛；监控告警 Sentry 待 DSN 生效
- 订阅结转：月配额未使用部分的 30% 结转到下一周期（`lib/ledger.ts` 的 `fulfillOrder`）。本平台**不自动续费**，所以发放发生在"周期结束后的下一次购买订阅"时；提前续费的客户晚一个周期拿到（在下一次续费时结算上一个已结束周期）
- 已知边界（有意保留）：视频输出不做内容审核（无视频审核通道）；免费档视频无水印；2FA 一旦被他人绑定，改密码不会清除该绑定（改密本身会踢掉攻击者的会话与 API Key），解绑需运维执行 `scripts/reset-2fa.ts`；密码重置不清除 2FA 失败累计刹车（否则邮箱被盗者可按重置次数反复换 20 次验证码尝试），解锁靠 24 小时窗口或 `scripts/reset-2fa.ts`；生产部署的支付配置（`PAYMENT_PROVIDER` + 对应 webhook 密钥）改为**启动时校验**，配错即拒绝启动（见 [docs/deploy.md](docs/deploy.md)）

## 目录

```
app/                 Next.js 页面与 API 路由（工作台 /studio；含 /api/health、/api/files、GDPR 接口）
components/          工作台客户端组件
lib/                 核心服务（账本/队列/成本/Provider/存储/限流/安全/认证）
prisma/              schema + 迁移 + 种子
scripts/             worker / rollover / recover / backup
tests/               单元测试（vitest）
e2e/                 端到端测试（playwright）
designs/             高保真设计原型与预览图
docs/archive/        归档的调研与共创过程记录（findings/progress/research）
docs/                PRD、合规文档、共创记录
.github/workflows/    CI
```
