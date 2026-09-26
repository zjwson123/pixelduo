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
4. 生图与审核 Key：`MODELVERSE_IMAGE_API_KEY`、`ARK_IMAGE_API_KEY`、`DEEPSEEK_API_KEY`、`VISION_MODERATION_API_KEY`（无独立 key 时可用 `VISION_MODERATION_BASE_URL` + 同款 ModelVerse key）。**审核网关必须是公网 http(s) 地址**：该请求带着审核 key 和待审图片，走的是 SSRF 防护 + DNS 钉死的客户端（与 `IMAGE_NSFW_ENDPOINT` 同一规则），内网/回环地址会被判为不可用 → 任务按"审核不可用"失败并退款，而不是把未审核的图片交付出去
5. 社交登录（可选）：`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` 四个**全部**设置才会启用对应 provider（`lib/auth.ts`）；三个 compose 文件均已转发这四个变量，不设置则登录页不显示任何第三方按钮
6. `NEXTAUTH_SECRET`（`openssl rand -base64 32` 生成）。它给所有会话 JWT 签名：**少于 32 位或仍是占位符（如 `change-me-…`）时生产环境拒绝启动**（`instrumentation.ts`），不要沿用 `.env.example` 里的示例值

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

### 会被静默忽略的配置（启动时告警）

`DEEPSEEK_API_KEY` 与 `DEEPSEEK_BASE_URL` 是**一对**（`lib/keys.ts` 原子解析）：只设一个时这一对被整体忽略——AI 润色退回离线模板、智能路由退回静态默认值，而 key 明明就在容器里。三个 Compose 锚点以前只转发 key，于是"按文档配了 key"得到的是一台静默降级的部署。现在两个变量都会被转发，启动时也会有一行告警说明这一点：

```
[config] DEEPSEEK_API_KEY is set but DEEPSEEK_BASE_URL is not — ...
```

其它文档里写过、而锚点没点名的变量（`IMAGE_NSFW_ENDPOINT`、`WATERMARK_TEXT`、`CHECKIN_TIMEZONE`、`FEEDBACK_NOTIFY_LIMIT`、`AUTH_MAIL_HOURLY_LIMIT`、`SENTRY_TRACES_SAMPLE_RATE`、`TRUST_X_REAL_IP`）现在也都在锚点里——其中影响最大的是 `IMAGE_NSFW_ENDPOINT`：文档说它"设置后优先于 vision 审核"，但以前它进不了容器，于是"外接审核 + `IMAGE_MODERATION=0`"这套组合既不跑外接审核、也不跑 vision 审核，worker 却照常启动并交付未经审核的图片。

### 认证邮件的全局上限

`AUTH_MAIL_HOURLY_LIMIT`（默认 `300`/小时，全局）：验证邮件 + 重置密码邮件共用同一个 SMTP 配额，而这两个接口都不需要登录、各自只受"每 IP 5 次 / 15 分钟 + 每账号 5 次 / 15 分钟"约束——N 个来源 IP 就是 N 倍邮件量。超出上限时**跳过发信**，并且**同时跳过令牌轮换**，所以用户邮箱里已经收到的那封链接仍然有效（只是不再生成新的）；跳过会写一行日志。另外重置链接的轮换有了 30 分钟宽限期：在此之内重新申请不会作废用户手上正在点的链接——否则任何知道你邮箱的人每 3 分钟请求一次，就能让"找回密码"对你永久失效。

### 积分不变式与修复脚本

两条规则必须始终成立（`lib/ledger.ts`）：`User.credits == SUM(CreditGrant.remaining)`，以及 `0 <= CreditGrant.remaining <= CreditGrant.amount`。

迁移 `20260926120000_credit_grant_invariant_check` 把它们加成了数据库级 `CHECK`，但用的是 `NOT VALID`：**对之后每一次写入立即生效，但不去扫描历史行**——所以一张已经含坏行的表不会让引入规则的这次迁移失败。历史坏行用脚本处理（幂等，健康的库上什么也不做）：

```bash
npx tsx scripts/repair-credit-invariant.ts          # 只报告：哪些行越界、哪些账号余额与明细不符
npx tsx scripts/repair-credit-invariant.ts --fix    # 修复：把越界行夹回 [0, amount]，把余额改成明细之和，并写一条 ADMIN 流水
```

修复完可以让它变成完整的保证（一遍单表扫描，仍有坏行就会明确报错而不是默默接受）：

```sql
ALTER TABLE "CreditGrant" VALIDATE CONSTRAINT "CreditGrant_remaining_range";
```

### 用户反馈（`/feedback`）

留言会存进 `Feedback` 表（管理台 **feedback** 标签页 = 收件箱），同时把通知邮件发到 `FEEDBACK_TO`。邮件用纯文本，`Reply-To` 是留言者本人，所以在邮箱里直接回复就是回复用户。

**`FEEDBACK_TO` 在生产环境必须显式设置。** 代码里的兜底地址是开发者的个人邮箱（只为本地调试与测试留一个人收件人），生产运行时**不会**用它：未设置时就不发通知邮件，并把原因写进"最近一次发信失败"（管理台 feedback 标签页会显示），留言本身照旧入库可见。这样"漏配一个变量"的后果是"少一封邮件 + 一条明确报错"，而不是"把用户留言内容、邮箱、账号、套餐、来源页和 User-Agent 发给第三方"。

- `FEEDBACK_TO`（**生产必填**）：客服别名/工单邮箱/邮件列表，改它不需要动代码。三个 Compose 文件的 `x-appenv` 锚点都转发这个变量——Compose 只把 `environment:` 里点名的变量传进容器，这正是以前"文档里写了、容器里配了也不生效"的原因
- `FEEDBACK_WEBHOOK_URL` / `FEEDBACK_WEBHOOK_KIND`（可选）：见下方群机器人一节，同样只有进了锚点名单才能到达容器
- `FEEDBACK_NOTIFY_LIMIT`（可选，默认 `60`）：**全局**出站通知上限（条/小时，跨所有来源 IP）。每 IP 5 条 / 10 分钟与每账号 5 条 / 10 分钟只约束单个发送者，N 个来源 IP 就能把通知量放大 N 倍——而每封通知花的是与验证邮件、重置密码邮件共享的 SMTP 配额。超出上限**只停通知**，留言照旧入库、照旧把 id 返回给提交者
- 表单对登录与未登录都开放（登录不上的人也必须能找到你），因此限流是双轴的：每 IP 5 条 / 10 分钟 + 每账号 5 条 / 10 分钟；未登录必须填回复邮箱。完全相同的重复提交（网络抖动后的重试）在 10 分钟内只通知一次，避免一次重试放大成一串通知
- 自动附带的定位信息：套餐、界面语言、来源页面（只取路径，不含 query，避免把重置令牌之类带进邮箱）、User-Agent
- SMTP 故障不会丢留言：先入库再发信，发信失败只记录告警
- 管理台收件箱按页读取（每页 50 条，界面显示 `N–M of 总数` 并提供上一页/下一页）：总量再大也能翻到任意一条，不会因为后来的刷屏把更早的留言永久顶出视野

**一条命令配置 + 验证投递**（推荐；它会写 `.env`，只改那两个键并留 `.env.bak`，然后立刻发一封真实通知并把接收端应答打出来）：

```bash
npx tsx scripts/setup-mail.ts <provider> <凭据> [发信地址]
npx tsx scripts/setup-mail.ts aliyun no-reply@你的域名 <DirectMail密码>   # 大陆服务器首选
npx tsx scripts/setup-mail.ts qq 你的QQ号@qq.com <授权码>                # 或 163
npx tsx scripts/setup-mail.ts resend <API_KEY> "PixelDuo <no-reply@你的域名>"
npx tsx scripts/setup-mail.ts local 2525                                # 无账号演练（配本地 sink）
```

它只写 `SMTP_URL` / `EMAIL_FROM`；`FEEDBACK_TO` 要自己加进 `.env`（并在当前 shell 里 `export`，脚本读的是环境变量而不是文件），否则上面的投递检查会以"生产拒绝用兜底地址"失败——这正是它该有的失败方式。

**脚本打印的连接串一律打码**（形如 `smtps://…(29 chars)@smtp.qq.com:465`、`https://open.feishu.cn/open-apis/bot/v2/hook/…(36 chars)`）：`SMTP_URL` 的 userinfo 就是 SMTP 密码，群机器人 URL 本身就是 token，而文档与失败提示都让运维把脚本输出贴到工单/群里。方案、主机、端口照旧显示——465/587 这类真实的首次配置错误仍然一眼可辨。

**先从大陆网络实测的可达性（2026-09-20，本机同处国内）**：`smtpdm.aliyun.com:465`、`smtp.qq.com:465`、`smtp.163.com:465`、`smtp.resend.com:587`、`smtp.sendgrid.net:587` **可达**；**`smtp.gmail.com:465` 不可达**（被墙）。所以大陆主机请优先 aliyun/qq/163，别用 Gmail SMTP。（部署主机的网络才是决定性的，但同一网络环境下这个结论基本一致。）

**更省事的替代通道：飞书/企微/钉钉群机器人（无需域名、无需 SPF、无需密码）**——在群里添加"自定义机器人"拿到 webhook URL，然后：

```bash
FEEDBACK_WEBHOOK_URL="https://open.feishu.cn/open-apis/bot/v2/hook/xxxx"   # 默认按飞书格式发
FEEDBACK_WEBHOOK_KIND="feishu|wecom|dingtalk|raw"                          # 默认 feishu
```

留言入库后会同时推送到这个群（`[PixelDuo] 反馈 · <分类>` + 留言者/套餐/来源页 + 参考号），与邮件互不依赖：两个都配就都发，都没配就只留在管理台收件箱。只接受 `https://`（本机回环地址除外），并且目标必须解析到公网地址（私网/链路本地/`169.254.169.254` 这类元数据地址一律拒绝），POST 不跟随重定向、回包只读前 8 KB——端点替我们决定请求发往哪里、或用一个超大响应撑爆进程的路子都被堵掉了。管理台 feedback 标签页会分别显示两个通道是否已配置。

配好之后一条命令验证（等价于邮件侧的 `verify-mail.ts`）：

```bash
FEEDBACK_WEBHOOK_URL="https://…" npx tsx scripts/verify-webhook.ts
# → endpoint: 200 {"code":0,"msg":"success"}
# → [OK] / [FAIL]（失败时按 errcode 给出原因：关键词校验、签名校验、token 失效、网络不通）
npx tsx scripts/verify-webhook.ts --print    # 只打印将要发送的 JSON，不发送
```

它以退出码反映成败，可直接当部署门禁；端点返回 200 但 body 里 `errcode`/`code` 非 0 也算失败——钉钉/企微正是这么拒绝消息的（缺关键词等），只认 HTTP 状态会把"静默丢弃"当成成功。

支持的 provider：`aliyun`、`qq`、`163`、`resend`、`sendgrid`、`postmark`、`ses`、`gmail`、`local`（不带参数运行会列出全部与注意事项）。脚本内置了主机/端口/协议，并在写盘前校验：**465 必须 `smtps://`（一上来就 TLS），587 用 `smtp://`（STARTTLS 升级）**——这对写错就是卡到超时，是首次配置最常见的失败。

只想验证已写好的配置：

```bash
npx tsx scripts/verify-mail.ts
# → transport / from / recipient
# → server response: 250 2.0.0 Ok: queued as …      ← 接收端自己的应答，这才是投递证据
# → [OK] / [FAIL]（失败时给出具体提示：535 认证、域名未验证、465/587、配额/沙箱等）
```

它以退出码反映成败，可直接当部署门禁；无 `SMTP_URL` 时它主动失败并说明原因，**不会**让你误以为"没报错就是发出去了"。管理台 feedback 标签页在未配置时会显示提示条，配好之后还会显示**最近一次发信的结果**（成功是 250 应答，失败是具体错误）——因为"配了"不等于"能发"。不接 SMTP 也能用：留言仍在管理台 feedback 收件箱里，只是不会推送到邮箱。

## 部署步骤

```bash
# 1. 先配置环境变量（也可用 .env.production 或密钥管理器注入）
#    顺序不能反：`docker compose build` 会先对整个文件做变量插值，而默认
#    compose 文件里 NEXTAUTH_SECRET 是 ${NEXTAUTH_SECRET:?...}（缺失即报错），
#    所以先 build 会在全新 clone 上直接失败 —— 一步都还没走。
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
# Mail: production refuses to boot without SMTP_URL (instrumentation.ts).
# FEEDBACK_TO names the inbox that receives user feedback — a production runtime
# refuses to send feedback notifications to the built-in fallback address, so
# leave it out and the admin console reports a refused send instead of delivery.
export SMTP_URL="smtps://..."
export EMAIL_FROM="PixelDuo <no-reply@pixelduo.ai>"
export FEEDBACK_TO="support@yourdomain.com"

# 2. 构建镜像（必须用默认文件构建：build: 段与 NEXTAUTH_URL /
#    NEXT_PUBLIC_SENTRY_DSN 等构建参数都在 docker-compose.yml 里；
#    docker-compose.prod.yml 只声明镜像名，对它执行 build 不会构建任何东西，
#    却会以 0 退出，看起来像成功 —— 升级实际跑的还是旧镜像）
#    构建期必须传入站点域名：静态页面里的 og:url / og:image 是构建时烧进去的
#    （app/layout.tsx 的 metadataBase，见 lib/site.ts），缺省时写成
#    http://localhost:3000 —— 页面照常 200，只有分享预览指向构建机的本地地址。
#    robots.txt / sitemap.xml 已改为请求期读取，不受构建环境影响。
NEXTAUTH_URL="https://pixelduo.ai" docker compose build migrate web worker rollover
# Optional second channel (Feishu/WeCom/DingTalk group bot, no domain needed):
# export FEEDBACK_WEBHOOK_URL="https://open.feishu.cn/open-apis/bot/v2/hook/..."
# export FEEDBACK_WEBHOOK_KIND="feishu"
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
NEXTAUTH_URL="https://pixelduo.ai" docker compose build migrate web worker rollover   # 域名必须带（构建期元数据）
docker compose -f docker-compose.prod.yml up -d
```

### 迁移

`web` / `worker` 现在 `depends_on: migrate`（`condition: service_completed_successfully`），由 compose 先跑一次 `npx prisma migrate deploy`（迁移是幂等的）再启动应用容器 —— 三个 compose 文件里都有这个服务。在此之前 prod.yml 没有 `migrate`，而本文档声称"迁移会由部署流程执行"：按文档在**空库**上 `up -d` 得到的是一个没有 schema 的栈，而且它**看起来是健康的** —— `/api/health` 的数据库探针是 `SELECT 1`，不需要任何表，于是容器健康检查和 Caddy 全部通过，而每个业务路由都在 500（`relation "User" does not exist`）。

手动执行（或 CI 里单独跑）仍然可以：`docker compose -f docker-compose.prod.yml run --rm migrate`。升级含 schema 变更时先跑迁移再切流量。

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
- [ ] 通知通道至少配一条并验证过：`FEEDBACK_TO` 指向运维/客服收件箱（生产未设置时**不发**反馈通知邮件，只记失败），配好后跑 `npx tsx scripts/verify-mail.ts` 拿到接收端 250 应答；或配群机器人并跑 `npx tsx scripts/verify-webhook.ts`
- [ ] `PAYMENT_PROVIDER=stripe|paddle` + 对应生产 key/webhook secret（两 Provider 已实现；真实沙箱全流程验证后切生产，**禁止 mock 上生产**）
- [ ] Sentry DSN 生效且收到测试告警
- [ ] 备份恢复演练已在生产环境复跑
- [ ] 日志脱敏抽查（不出现密码/Token/支付原文）
