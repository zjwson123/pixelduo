# 进度日志

## 2026-08-10

- 创建任务计划与调研文件
- 确认工作区为空（greenfield）
- 开始官方 API 定价调研 + 三路竞品子代理并行调研
- 主代理补充支付/合规/开源计费参考调研 → research/payment_research.md
- 产品大纲 v0.1 草稿建立 → product-outline.md（竞品章节待子代理填充）
- 子代理 C 完成 → research/oss-ecosystem.md；子代理 B 支付部分完成 → research/payment_research.md
- 子代理 A 无产出被中断，主代理补完海外竞品调研
- 综合分析完成，撰写 PRODUCT_OUTLINE.md（v0.2），合并子代理草稿（product-outline.md 已删除）
- 待办：向用户呈现大纲 + 收集关键决策点（§11）

## 2026-08-11

- 用户决策：国内 + 海外（欧美优先）双市场；支付需支持支付宝/微信；积分 12 个月有效 + 月配额结转 30%；免费额度通过
- 核实：Paddle MoR 机制与大陆开户门槛、国内支付宝/微信商户资质、国内 AIGC 备案要求
- 大纲更新至 v0.3：双支付轨、双合规、双模型通道、人民币折算价、SFW 红线说明
- 待用户拍板：收款主体（个体户/海外公司）、备案节奏、国内版模型策略、品牌域名

## 2026-08-11（续）

- 澄清 API 可达性：generate-image skill（eagent 代理）中 gpt-image-2 + doubao-seedream 均已可用；"OpenAI 大陆不可直连"仅指官方直连渠道
- 核实主体实操：个体户（免费、ICP 可办、AIGC 备案实操多数要求企业法人）、香港公司（注册 HK$1.5–3k、年维护 ¥8k–15k）、Airwallex（大陆主体可开收美元）
- 大纲更新至 v0.4：模型通道澄清、收款主体三选项、备案用户清单、PixelDuo 命名说明

## 2026-08-11（黑暗测试 + 域名）

- 域名核查：pixelduo/dualpix/twoframe/openpix/clearframe/picflow/pixduo/twinpix 的 .com 全部被占；pixelduo.ai、dualpix.ai、twoframe.ai、pixduo.ai 可用
- 黑暗测试（eagent 代理实测）：gpt high 148s/约 $0.211；gpt medium 35s/$0.053（1756 token）；seedream 1920² 15s/¥0.3 且自带"AI生成"水印
- 大纲更新至 v0.5：实测成本/延迟、分模型延迟指标、gpt high 定价建议 26–28 分、去水印权益定义
- 待拍板：品牌域名（pixelduo.ai?）、收款主体、备案节奏、国内版模型策略、去水印权益口径

## 2026-08-11（决策锁定）

- 品牌锁定：PixelDuo / pixelduo.ai
- 收款与备案策略锁定："壳子先行、产品优先"——MVP 免费 Beta（海外托管），积分/订阅逻辑真实实现，支付层做可切换壳子；主体/备案/真实收款后置到 P3 商业化阶段
- 大纲更新至 v0.6；下一步：PRD + 高保真 UI 原型（baoyu-design）

## 2026-08-11（PRD + UI 原型）

- 产出高保真 HTML 原型：designs/pixelduo/landing.html（落地页）+ app.html 交互工作台（React/Babel 多文件：data/icons/components/app.jsx）
- 视觉方向（自主定夺）：专业创作工作台 + 画廊优先；暖纸底色 + 靛蓝/橙双色品牌；衬线标题（Georgia/Songti）+ 系统无衬线正文；亮/暗双主题
- 原型包含：成本预览、双模型对比生成、DeepSeek Prompt 助手、模板库、画廊、定价与支付壳子弹窗（Beta 模拟）
- Playwright 功能验证通过（无报错、生成扣积分、模板套用、深色模式、弹窗交互正常）；截图存 designs/pixelduo/preview/
- 修正成本基准：配置的模型为 Seedream 5.0 Lite（约 $0.035/张），¥0.3–0.6 为 5.0 Pro 档位
- 待办：用户查看原型 → 反馈视觉/功能调整 → PRD 定稿

## 2026-08-11（MVP 端到端实现与测试）

- 脚手架：Next.js 14 + TS + Prisma 6(SQLite) + NextAuth v4；npm install / build 通过
- 数据模型：User/LedgerEntry/Job/Image/Template/Order/PaymentEvent/Checkin（双记账账本、幂等键）
- 核心服务：成本模型（seedream 6 / gpt medium 8 / gpt high 26 积分）、账本（预扣→结算/失败退款）、DB 队列、ImageProvider（ModelVerse + 火山方舟真实调用 + mock 模式）、内容安全、DeepSeek 助手（离线兜底）
- API 全部实现：register/auth/me/generate/jobs/gallery/ledger/checkin/assistant/templates/checkout/webhooks
- 前端：落地页、登录/注册、工作台（创作/灵感/画廊/账本/定价五页签）、支付壳子弹窗
- 测试：单元测试 9/9 通过；Playwright e2e 1/1 通过（注册→生成→模板→充值→账本）
- 真实 API 冒烟：Seedream 5.0 Lite 15s 出图（30→24 积分）、gpt-image-2 medium 35s 出图（24→16 积分），账本完整、图片落盘
- 环境说明：无 Postgres/Redis → SQLite + DB 队列（部署可切换）

## 2026-08-11（MVP 收尾补齐）

- 实现月度 30% 结转（lib/rollover.ts + scripts/rollover.ts + 单元测试：granted 2000 / spent 482 → 结转 455、周期推进、幂等）
- 模板库扩至 8 类 × 20 = 160 条（手工精选 + 程序化变体），dev/test 双库已种子
- 基础 i18n（工作台 EN/中文 切换）、免费档水印角标（前端叠加）、图像侧可插拔安全审计（IMAGE_NSFW_ENDPOINT）
- 最终验证：单元测试 11/11、e2e 1/1、真实 API 冒烟（Seedream 15s / gpt medium 35s 真实出图）、生产构建通过
- 已知上线前项（非 MVP）：真实支付渠道、主体/备案、图像 NSFW 检测器接入、结转积分过期任务、烘焙水印

## 2026-08-11（P0 商用化改造）

- 数据库：SQLite → **Postgres 16**（docker compose + Prisma 迁移，dev/test 双库；Docker daemon 已启动）
- 存储：本地 public → **存储抽象**（local 私有目录 + 鉴权路由 `/api/files`，401 验证；S3/MinIO/R2 预签名实现）
- 限流：中间件（auth 20/min、API 300/min per IP）+ 路由级（generate/assistant/checkout/register）→ 10 次注册后 429 实测
- Worker：指数退避重试（3 次）、心跳、卡死恢复、终态失败=DLQ+退款（13/13 单测含重试语义）
- 安全：CSP/HSTS/nosniff/X-Frame/Referrer/Permissions-Policy + poweredByHeader off（curl 实测）
- 幂等：生成接口客户端 idempotencyKey（e2e 验证同 key 不重复扣费）
- 部署：Dockerfile（web/worker 双目标，standalone）、docker-compose 全栈（migrate/web/worker/rollover/db/storage/init-storage）、GitHub Actions CI
- 运营：备份脚本（pg_dump + 轮转 14 份）、/api/health、GDPR 导出/删除 API、合规文档（ToS/Privacy/清单）
- 验证：单测 13/13、e2e 4/4（含幂等/401/健康）、真实生图冒烟（Postgres + 私有存储 + 鉴权渲染 + 30→24 积分）、构建通过、Docker 镜像构建中
- P1+ 待办：真实支付、主体/备案、NSFW 检测器、多实例限流（Redis）、Sentry 告警、结转积分过期任务、烘焙水印

## 2026-08-11（P0 全栈验证收尾）

- **compose 健康检查修复**：Docker 自动注入 `HOSTNAME`（容器 ID）导致 Next.js standalone 只监听容器 IP、容器内 localhost 探测被拒；busybox `wget` 又把 `localhost` 解析为 `::1`。修复 = compose 注入 `HOSTNAME=0.0.0.0` + 健康检查显式用 `127.0.0.1` → web healthy
- **S3 端到端验证**：storage 模块对 MinIO 实测 put / 预签名 URL 匿名访问 200 / delete 通过；compose 全栈（web+worker+S3 驱动）注册→登录→生成→任务 done→对象落桶 `img/*.png` 通过
- **路由收尾**：e2e `waitForURL` 从 `**/app` 改为 `**/studio`；register/login 跳转目标 `/app` → `/studio`；发现并重建了在目录改名**前**构建的 web 镜像（旧产物仍含 `app/app/`，导致全站 307 到 /login）——重建后 `/login`、`/register` 200，`/studio` 未登录 307 正确
- **本地依赖修复**：Docker 构建污染了宿主 `node_modules`（esbuild/Prisma 引擎为 Linux 二进制）→ 重装 esbuild + `npx prisma generate` 恢复 darwin 引擎
- **验证**：单测 13/13、e2e 4/4（含 /studio 跳转、幂等、401、健康）、compose 全栈 healthy + S3 冒烟通过
- 已知配置注意：compose 内部预签名 URL 用 `http://storage:9000`（容器内可达）；生产需将 `S3_ENDPOINT` 配为公网可达地址

## 2026-08-11（真实生图链路 + 积分过期体系）

- **真实生图链路在 compose 全栈打通**：把 `~/.cc-proxy/config.json` 挂载进 web/worker 容器（`${CC_PROXY_CONFIG:-${HOME}/.cc-proxy/config.json}:ro`），关闭 mock 后实测——Seedream 真实出图（1920×1920 JPEG、551 KiB、自带"AI生成"水印，30→24 分）、GPT-Image-2 真实出图（1024×1024 PNG，30→22 分），图片落 MinIO，账本完整
- **积分过期体系（P1 完成）**：新增 `CreditGrant` 表（source/amount/remaining/expiresAt），`User.credits == SUM(remaining)` 不变量；消费按"免费优先 → 到期日 FIFO"（`FOR UPDATE` 行锁防并发超扣）；退款精确归还原 grant（expiry 不变）；充值包 12 个月过期、订阅配额到期即失效、结转 30% 仅次月有效；`lib/expiry.ts` + `scripts/expire.ts` 每日清扫（compose rollover 容器内置）
- 迁移 `20260811054933_credit_grants`：含存量余额回填（legacy 永不过期 grant）
- 测试：单测 18/18（新增 expiry 5 例：免费优先、精确退款、FIFO、过期清扫、原子性）、e2e 4/4、生产构建通过；compose 全栈真实生图 + 过期清扫端到端验证通过
- 产品决策记录：免费积分（注册/签到）永不过期且**优先消耗**（防薅羊毛口径：免费池不可囤积、不可稀释付费积分）；"到期前 30 天提醒"待通知基建（P2）

## 2026-08-11（Sentry 监控告警接入 P1）

- 安装 `@sentry/nextjs@8.55` + `@sentry/node@8.55`；新增 `sentry.{server,client,edge}.config.ts` + `instrumentation.ts`（Next 14 需 `experimental.instrumentationHook`），`next.config.mjs` 用 `withSentryConfig` 包装——**仅当 `SENTRY_DSN` 存在时激活**，无 DSN 时全部 no-op，本地/CI 零外部依赖
- 统一错误采集：`lib/api.ts` 的 `fail()` 出口自动上报非业务性 500（`invalid-*`/`blocked:`/`insufficient`/`not-found`/`unauthorized` 等预期错误跳过）；worker/rollover/expire 用 `lib/observability.ts`（`initObservability` + `captureError`，带 jobId 上下文）
- 配置透传：compose appenv 增加 `SENTRY_DSN`/`SENTRY_ENVIRONMENT`/`SENTRY_RELEASE`；`.env.example` 补齐
- 验证：单测 20/20（新增 observability 2 例：无 DSN no-op、有 DSN capture 不抛）、e2e 4/4、无 DSN 与有 DSN（假 DSN）两种构建均通过；带 DSN 的 compose 全栈真实生图冒烟通过（30→24），生产容器启动日志干净（dev 模式下的 OpenTelemetry "Critical dependency" 警告为已知噪音，仅本地开发出现）
- 上线前待办：申请真实 Sentry 项目 DSN 填入 `SENTRY_DSN` 并配 `SENTRY_ENVIRONMENT=production`；source map 上传需 `SENTRY_AUTH_TOKEN`（可选）

## 2026-08-11（多实例限流 Redis P2）

- **限流升级为 Redis 全局**：`lib/rate-limit.ts` 重构为限流器抽象——`MemoryRateLimiter`（滑动窗口，单机回退）+ `RedisRateLimiter`（固定窗口，原子 `INCR+EXPIRE`，TTL 计算 retry-after）；Redis 不可达时逐请求回退内存并在后台自动重连恢复，避免单点故障拖垮业务
- 权威限制在路由层（generate 20/min、register 10/h、checkout 10/min、assistant 30/min）改为 **Redis 跨实例共享**；`enforceRateLimit` 变异步，4 个路由已 await；`/api/health` 暴露 `rateLimiter: redis|memory` 便于运维确认
- middleware 边缘限流保持每实例内存（Edge 运行时无法用 ioredis），定位为粗筛第一道防线，注释已说明
- compose 新增 `redis:7-alpine` 服务（健康检查 + volume），appenv 注入 `REDIS_URL=redis://redis:6379`；CI 的 test-unit / e2e 作业增加 Redis 服务
- 测试：单测 24/24（新增 rate-limit 4 例：内存限流、窗口过期、**Redis 跨实例隔离**、窗口重置与 per-key）；e2e 4/4（Redis 路径）；compose 实测：health `rateLimiter: redis`、注册第 11 次精确 429、Redis 计数键 `rl:register:* = 11`
- 生产待办：托管 Redis（Upstash/ElastiCache）替代自建；限流键已按 IP+scope 隔离

## 2026-08-11（图像 NSFW 审核接入 + 备份自动化）

- **后置图像审核（上线前必做项完成）**：`lib/safety.ts` 新增 vision 模型审核——经 cc-proxy modelverse 网关调 `chat/completions`（默认 `gpt-5.4`，`VISION_MODERATION_MODEL` 可覆盖），把生成图从存储读出转 data URL 送审，返回 JSON `{"flagged": bool}`（解析兼容 markdown 围栏）；`IMAGE_MODERATION=1` 开启，`IMAGE_NSFW_ENDPOINT` 外部端点路径保留
- **审核命中即拦截**：worker 对 flagged 图像执行 `failJob(..., { terminal: true })`（跳过重试、立即退款）+ 删除存储中的违规图；`failJob` 新增 terminal 选项
- 真实验证：vision 调用格式实测通过（modelverse + gpt-5.4 + data URL → 200）；compose 全栈 `IMAGE_MODERATION=1` 下真实生图 → worker 日志 `safety audit passed (vision:gpt-5.4)`、任务 done、图片交付、余额 30→24
- **备份自动调度**：compose 新增 `backup` 服务（postgres:16-alpine，每日 `pg_dump -Fc` 到 `./backups/`，保留 14 份轮转）；实测 dump 生成 28KB，`pg_restore -l` 列出全部 10 张表（含 CreditGrant/User/Job/Ledger）
- 测试：单测 31/31（新增 safety 6 例：关键词中英过滤、解析干净/围栏/垃圾 JSON、未配置跳过；queue 终态失败退款 1 例）；e2e 4/4；生产构建通过
- 遗留：恢复演练、日志脱敏、密钥管理为上线清单项；gpt-image-2 侧 C2PA/水印标识待接

## 2026-08-11（恢复演练 + 生产部署准备）

- **备份恢复演练通过**：`pg_dump -Fc` dump 恢复到临时库 `pixelduo_restore_test`（pg_restore 建表+约束+数据全成功），5 张关键表行数与源库完全一致（User 20 / CreditGrant 21 / Job 10 / LedgerEntry 41 / Image 10），演练后清理
- **生产部署三件套**：
  - `Caddyfile`：Caddy 反代 web:3000，`CADDY_DOMAIN` 自动 Let's Encrypt（localhost 用本地证书）
  - `docker-compose.prod.yml`：独立生产栈（caddy + web + worker + rollover），数据全部走托管服务（`DATABASE_URL`/`REDIS_URL`/`S3_*` 严格插值缺失即报错），db/redis/storage 端口不对公网暴露，web 仅内网 3000 + 健康检查，`IMAGE_MODERATION=1`、`SENTRY_ENVIRONMENT=production` 默认
  - `docs/deploy.md`：VPS 部署步骤、升级/回滚/备份恢复/上线核对清单
- vision 审核支持纯 env 配置（`VISION_MODERATION_BASE_URL`/`VISION_MODERATION_API_KEY`，生产无 cc-proxy 文件时可用）
- **本地生产模式冒烟通过**：prod 栈起 4 容器（caddy/web/worker/rollover），Caddy 自动签 localhost 证书、HTTP→HTTPS 308、`curl -k https://localhost/api/health` → `db:up rateLimiter:redis`、经 HTTPS 注册用户成功；验证后已拆除

## 2026-08-11（日志脱敏 + gpt 烘焙水印）

- **日志脱敏加固**：审计全部日志语句（仅 jobId/模型/数量，无密码/Token/prompt/支付原文）；新增 `redactSensitive()`（sk-/AKIA/Bearer/预签名串打码）应用于 captureError 与 Sentry 上报；`fail()` 对非业务性 500 只回客户端 `internal-error`（真实错误进日志/Sentry），不泄露内部细节
- **gpt-image-2 烘焙水印**：`lib/watermark.ts`（sharp 合成 "PixelDuo · AI 生成" 徽标，尺寸自适应，`WATERMARK_TEXT` 可覆盖）；worker 对**免费档 gpt 图片**在交付前烘焙（Seedream 自带 AI 生成标识；付费去水印为后续产品项）；Dockerfile worker 镜像安装 `fontconfig + font-noto-cjk`（否则容器内 SVG 文字不渲染）
- 测试：单测 33/33（新增 watermark 2 例：有效 PNG + 徽标合成）；e2e 4/4；构建通过
- 真实验证：compose 全栈真实 gpt 生成 → 烘焙 → vision 审核通过 → 交付；程序化验证交付图底部有暗色徽标底 + 白色文字像素（1487 px）；修复前无字体时文字缺失（亮度 63/0 白像素），装字体后正常（53/1268）
- 遗留：C2PA 元数据嵌入（gpt 付费档标识）为后续项

## 2026-08-11（Stripe 支付沙箱接入）

- **支付抽象落地**：`lib/payments/{types,mock,stripe,index}.ts`——`PaymentProvider` 接口（createCheckout + verifyWebhook 验签），`getPaymentProvider()` 按 `PAYMENT_PROVIDER` 切换；mock 保留内联即时到账
- **StripeProvider**：Stripe Checkout 建会话（金额转分、client_reference_id/orderId 元数据、成功/取消 URL 可配）；webhook 用 `stripe.webhooks.constructEvent` 验签，处理 `checkout.session.completed`（paid → 履约到账）与 `charge.refunded`（refunded → 订单标记），eventId 幂等
- **路由改造**：checkout 对真实 Provider 返回 `checkoutUrl` 并存储 `providerOrderId`（前端收到即跳转 Stripe）；webhook 先验签后处理（无签名/坏签名 400，不信任报文里的 provider 字段）
- **测试**：单测 37/37（新增 payments 4 例：mock 建单+webhook、createCheckout 注入 fake client、HMAC 构造签名验证 paid 事件、坏签名/非支付事件拒绝）；e2e 4/4；构建通过
- **运行时验证**：compose 切 `PAYMENT_PROVIDER=stripe`（dummy key）实测 webhook 无签名返回 400；修复了基础 compose 未透传 stripe env 的问题；验证后恢复 mock
- 待办：申请 Stripe 测试 key 走真实沙箱支付全流程；生产 key + 主体决策后切生产；Paddle/支付宝/微信按同一接口补 Provider

## 2026-08-11（支付 webhook 端到端验证 + 订单历史 API）

- **Webhook 端到端模拟工具**：`scripts/test-webhook.ts`——本地生成 Stripe 格式签名（HMAC-SHA256）的 `checkout.session.completed` 事件并 POST 到 `/api/webhooks/payment`，支持直接建 pending 订单（`--create-order <email> <credits>`）
- **运行时验证通过**：compose 切 stripe 模式（dummy key + whsec_test），注册用户 → 脚本建 pending 订单(+1050) → 签名 webhook → HTTP 200 → 订单 paid → 余额 30→1080；验证后恢复 mock
- **订单历史 API**：`GET /api/orders`——当前用户最近 50 笔订单（kind/provider/金额/积分/状态/时间），未登录 401；e2e 增加断言（mock 结账后订单列表含 paid 的 pack）
- 测试：单测 37/37、e2e 4/4（含订单断言）、构建通过；compose 全栈 healthy
- 下一步：Stripe 真实沙箱 key 全流程、Paddle/支付宝/微信 Provider、订单页 UI/收据

## 2026-08-11（订单页 UI）

- 工作台新增 **Orders 页签**（EN/中文）：展示最近 50 笔订单（时间/商品/金额/积分/状态/渠道），paid/pending/refunded 三色状态徽标；结账成功后自动刷新；空状态提示
- e2e 新增断言：mock 结账后切到 Orders 页签，表格含 "1050 credits pack" 与 "Paid"；4/4 通过
- 截图存 `designs/pixelduo/preview/orders-tab.png`

## 2026-08-11（商用就绪度体检 + P0 账单/合规修复）

**体检结论**：工程底子扎实（架构/数据库/稳定性/并发/账号均有实现与验证），但作为"对外收费商用产品"有 4 个 P0 缺口，本轮按代码可修项全部落地：

1. **退款不扣积分（会直接亏钱）→ 已修**：`revokeOrderCreditsTx`（ledger）按订单 `refId` 精确扣回该订单未消耗积分（`REVOKE` 账本类型，不变量 `credits == SUM(remaining)` 保证余额可覆盖）；webhook `refunded` 分支先标记订单再扣积分。CreditGrant 新增 `refType/refId` 列（迁移 `20260811080000_credit_grant_refs`）
2. **订阅到期永不降级 + 无限结转（计费 bug）→ 已修**：`rollover` 任务改为**到期降级 free**（`downgradeExpiredPlans`，并发安全 re-check）；30% 结转移到**续费时发放**（`fulfillOrder` plan 分支：上一周期已结束才结转，提前续费不结转且周期从原到期日顺延）
3. **webhook 原文存 PII → 已修**：`lib/payments/sanitize.ts` 递归按键脱敏（email/name/address/card/last4/fingerprint/receipt 等），`PaymentEvent.rawJson` 只存脱敏后数据
4. **支付仍是壳子 → Paddle Provider 已实现**：`lib/payments/paddle.ts`（SDK v3.10，sandbox/production 切换，create transaction 非目录价格+分单位金额，`Paddle-Signature` 验签带 5 秒防重放，`transaction.completed`→paid、`adjustment.created`(refund/chargeback, approved)→refunded，退款经 `transactionId→providerOrderId` 回查订单）；`index.ts` 接线，env/compose（dev+prod）补齐 `PADDLE_*`

**顺手修复**：webhook 处理改原子——`fulfillOrder` 支持注入事务客户端，paymentEvent+履约+扣回同事务，部分失败重试不再被幂等吞掉；订单解析支持 `providerOrderId` 回查（Stripe/Paddle 退款 webhook 不 echo 我们的 orderId 时仍能定位订单）；`scripts/test-webhook.ts` 新增 `--refund <orderId>` 模拟 `charge.refunded`

**验证**：
- 单测 45/45（新增：Paddle 4 例含真实 SDK HMAC/过期时间戳/退款映射、sanitize 2 例、revoke 1 例、rollover 重写 3 例=续费结转/提前续费/到期降级）
- e2e 4/4；`tsc --noEmit` 通过；生产构建通过
- **运行时实测（重建镜像后）**：stripe 模式 webhook 到账 30→1080 → `--refund` 后订单 refunded、积分 1080→30（精确扣回 1050）；`scripts/rollover.ts` 将过期 pro 用户降级 free 并清空 `planRenewsAt`
- compose 已恢复 `PAYMENT_PROVIDER=mock`，全栈 healthy；测试数据已清理

**剩余 P0/P1（需用户/外部）**：真实支付沙箱全流程（Stripe/Paddle key）、支付宝/微信（主体）、邮箱验证+找回密码、图片对象异地备份（R2 版本控制/复制）、Sentry DSN 生效、git 初始化

## 2026-08-11（账号体系：邮箱验证 + 密码找回）

- **数据模型**：`User.emailVerified` + `VerificationToken`（purpose/tokenHash/expiresAt/consumedAt/userId 级联删除；迁移 `20260811090000_email_verification` + `20260811091000_verification_token_user`）
- **令牌服务** `lib/tokens.ts`：只存 SHA-256 哈希，验证 24h / 重置 1h 过期，单次使用，同邮箱同用途旧令牌自动作废；`expire` 任务顺带清理过期/已用令牌
- **邮件抽象** `lib/mail.ts`：未配 `SMTP_URL` 时开发模式打印链接到日志（`MAIL_DEV_DIR` 可落盘供 e2e 读取），生产接 nodemailer SMTP（SES/SendGrid/Resend）
- **API**：`request-verification`（登录后重发）、`verify-email`（验证成功才发 30 签到奖励，updateMany 防重复发奖）、`forgot-password`（恒返回 ok 防枚举）、`reset-password`（消费令牌 + bcrypt 重哈希）；注册改为**验证后才发奖励**；未验证账号调 generate/checkin 返回 403 `verify-email-required`
- **前端**：注册页"Check your inbox"、登录页"Forgot password?"、新增 `/forgot-password`、`/reset-password`、`/verify-email` 三页；工作台未验证横幅 + 重发按钮；账本新增 REVOKE 标签
- **测试**：单测 50/50（新增 auth-flow 5 例：令牌单次/过期/作废、注册→验证→发奖、找回→重置→旧密码失效、防枚举、清理）；e2e 新增 `verify-email.spec.ts`（无 `MAIL_DEV_DIR` 自动跳过），本地实测全流程通过：注册→未验证被拦（横幅+0 积分）→点邮件链接→验证成功→30 积分到账→生图解锁
- 顺手修复：e2e 注册限流在本地多轮跑测时累计触发 429 导致的偶发失败（测试基建问题，非产品 bug）；注册页 429 提示友好化
- 遗留：2FA / OAuth、会话吊销（JWT 策略）、邮件发送失败告警

## 2026-08-11（工程基建：git 仓库 + 对象备份 + 健康检查增强）

- **git 仓库初始化**：`git init -b main` + 首次提交（146 个文件）；`.gitignore` 补 `.DS_Store`/`.env.*`/`public/generated/` 等；入库前密钥扫描仅命中文档占位符（无真实密钥）
- **对象存储备份（补 P0"图片零备份"缺口）**：
  - `scripts/backup-objects.sh`：mc 镜像源桶到 `./backups/objects/<stamp>`，保留 N 份（默认 7），配 `BACKUP_TARGET_*` 可同步第二桶异地；修复 mc 镜像 entrypoint/xargs 两个坑（`--entrypoint /bin/sh` + while 循环轮转）
  - `scripts/restore-objects.sh`：快照恢复到 scratch 桶并自动校验对象数，不一致即失败退出
  - compose 新增 `backup-objects` 服务（每日运行，走内网 `storage:9000`）；`.env.example` 补 `BACKUP_*`
  - **实测**：源桶 10 对象 → 快照 10 文件 → 恢复到 scratch 桶 `RESTORE DRILL PASSED`（10/10）→ scratch 桶已清理；compose 服务日志确认每日镜像正常
- **健康检查增强**：`/api/health` 新增 `redis`/`storage`/`queue`（排队数、运行中数、worker 最近心跳）探活，每项 2.5s 超时兜底；`RedisRateLimiter.ping()` + `StorageDriver.health()`（local 自动建目录、s3 用 HeadBucket）
- **邮件失败告警**：`lib/mail.ts` 发送失败捕获上报 Sentry 并透出错误（验证/重置链接不静默丢失）
- **配置修复**：宿主 `.env` 的 `STORAGE_DRIVER` 漂移为 local（与 compose/README 默认 s3 不一致，导致健康检查报 storage down）——对齐为 s3，全栈恢复 `ok:true`
- **验证**：单测 52/52（新增 checkRedis、storage health）；e2e 4/4（health 断言新增 redis/storage/queue）；tsc/build 通过；compose 全栈 healthy

## 2026-08-11（安全加固 + 到期提醒）

- **登录防爆破**：`lib/login-guard.ts`（Redis 按账号 `loginfail:<email>` 计数，10 次失败/15 分钟锁定，成功登录清零，Redis 不可用降级为 no-op 不阻断认证）；接入 NextAuth authorize
- **会话吊销**：`User.sessionVersion`（迁移 `20260811100000_session_version_reminders`），登录时写入 JWT claim `sv`，`requireUserId/requireVerifiedUser` 每次校验版本（重置密码或 `POST /api/auth/revoke-sessions` 后旧会话立即 401）
- **积分到期提醒**：`lib/reminder.ts` + `scripts/remind.ts`——付费积分（PURCHASE/SUBSCRIPTION）到期前 7/3/1 天发提醒邮件，`CreditReminder(grantId, daysBefore)` 唯一约束去重；rollover 容器循环加入 remind 步骤（dev/prod compose）；发送失败 captureError 不阻塞任务
- **验证**：
  - 单测 55/55（新增 login-guard 1 例、reminder 2 例、auth-flow 补 sessionVersion 断言）
  - **运行时实测（重建镜像后）**：10 次错误密码 → 正确密码仍被拦（`error=CredentialsSignin`，Redis 计数=10）；解锁后登录成功；`/api/me` 200 → `revoke-sessions` → 同 cookie `/api/me` 401；造 2 天后到期 grant → `[remind] sent 1`（邮件 "expire in 3 days"）→ 重跑 `sent 0`（去重生效）
  - e2e 4/4（会话改动无回归）；tsc/build 通过；compose 全栈 healthy
- 遗留：2FA / OAuth（NextAuth v4 多步登录需要自研预认证态，建议升级 NextAuth v5 或引入 otplib 时一并做）

## 2026-08-11（订单收据 + 合规页面）

- **订单收据邮件**：`lib/mail.ts` 新增 `sendOrderReceiptEmail`；webhook 履约事务提交后发送（商品名/金额/到账积分），`fulfillOrder.alreadyPaid` 保证重复 webhook 不重发，投递失败仅 captureError 告警不回滚支付；事务改为返回收据对象（顺带绕开 TS 闭包窄化坑）
- **合规页面上线**：新增 `/terms`、`/privacy` 站内页（内容对齐 docs/compliance/terms.md、privacy.md），landing footer + 登录/注册页全部挂链——补齐上线清单"用户协议、隐私政策上线"项
- **验证**：单测 56/56（新增 receipt 1 例：首次支付发 1 封收据、重复 webhook 不重发）；e2e 5/5（新增 legal.spec：/terms /privacy 渲染 + footer 链接）；tsc/build 通过
- **容器实测**：stripe 模式 webhook 到账 → web 日志出现 `[mail:dev] ... Your PixelDuo receipt — 1050 credits pack`（Item/Amount/Credits 齐全）；已恢复 mock + 清理测试数据

## 2026-08-11（TOTP 双因素认证）

- **数据模型**：`User.totpSecret/totpPendingSecret/totpEnabled` + `BackupCode`（SHA-256 哈希、单次使用；迁移 `20260811110000_two_factor`）
- **核心库** `lib/twofa.ts`：otplib v12（window=1）生成/校验 TOTP + qrcode 出 QR；10 个一次性备用码（归一化 + 哈希存储）；**预认证票据**（jose HS256，5 分钟过期 + Redis jti 单次使用，Redis 不可用降级为仅过期保护）
- **两步登录**：authorize 密码通过后若开启 2FA 先发**部分会话**（totpPending）；`requireUserId`/`requireVerifiedUser`/studio/account layout 全部拦截部分会话（403 `2fa-required`）；`/api/auth/2fa-verify`（限流 5/min）验证 TOTP/备用码后签发预认证票据，前端再带票据 signIn 换取真会话
- **API**：`/api/2fa/setup`（生成 pending secret + QR）、`/api/2fa/confirm`（验证后启用 + 生成备用码，事务原子）、`/api/2fa/disable`（需密码 + 当前码，备用码不可用于禁用）、`/api/auth/2fa-status`
- **UI**：登录页两步流程（6 位码/备用码切换）、`/account/security` 启用/禁用页（QR + 密钥 + 备用码一次展示）、工作台右上角 Security 入口
- **测试基建修复**：中间件 /api/auth 粗限流改 env 可配（`MIDDLEWARE_AUTH_LIMIT`，e2e/CI 放大到 1000）；定位并解决 e2e 注册限流按 `:::1` 累计触顶的问题（跑测前清 Redis 键）
- **验证**：单测 60/60（新增 twofa 4 例：setup/verify、备用码单次、预认证票据单次+过期）；**e2e 6/6**（新增 2fa.spec 全流程：启用→TOTP 登录→部分会话 403 防护→备用码登录）；tsc/build 通过；compose 全栈 healthy

## 2026-08-11（SEO + 退款通知 + OAuth 登录）

- **SEO**：全局 metadata（metadataBase/OG/Twitter/robots）+ 落地页 metadata；`app/robots.ts`（屏蔽 /api/、/studio、/account/ 等）+ `app/sitemap.ts`（首页/登录/注册/条款/隐私）
- **退款通知邮件**：webhook 退款分支在事务提交后发送退款邮件（商品/金额），与积分扣回同一闭环，投递失败仅告警
- **OAuth（Google/GitHub）**：`GOOGLE_CLIENT_ID/SECRET`、`GITHUB_CLIENT_ID/SECRET` 配置即启用（不配置不显示按钮）；首次登录自动建号（邮箱视为已验证 + 发 30 积分，`ensureOAuthUser`）；**开启 2FA 的账号禁止 OAuth 登录**（signIn 回调拦截，避免绕过第二因子），登录页提示改用密码；登录/注册页新增 OAuth 按钮组件
- **修复回归**：jwt 回调曾把凭据登录误判为 OAuth（`token.uid` 首次为空 + 未区分 account.type），导致 totpPending 丢失、2FA 被跳过——改用 `account?.type === "oauth"` 路由后 e2e 复测通过
- **验证**：单测 64/64（新增 oauth 3 例：建号+奖励、幂等不重复、空邮箱拒绝；receipt 增退款 1 例：退款邮件 + 扣回 400 积分）；e2e 7/7（新增 robots/sitemap 断言）；tsc/build 通过；**容器实测**：robots.txt/sitemap.xml 200，stripe 退款 webhook → 退款邮件（Item/金额齐全）+ 积分 1050→0；已恢复 mock

## 2026-08-11（管理后台 Admin Console）

- **模型**：`User.role`（user/admin；迁移 `20260811120000_admin_role`）；账本新增 ADMIN 来源——`adminGrantTx`（补偿积分，永不过期、优先消耗）+ `adminClawbackTx`（FIFO 回收，免费/管理池优先，不变量 `credits == SUM(remaining)` 保持）
- **权限**：`requireAdmin()` 守卫全部 /api/admin/*（未登录 401、非管理员 403、2FA 部分会话 403）
- **API**：用户列表（搜索/分页）、积分调整（±、带备注，写账本）、角色升迁（不能自降）、删号（清图片+孤儿表）、订单列表、图片列表/删除（审核）
- **UI**：`/admin` 三页签（Users/Orders/Images），工作台右上角仅管理员可见 Admin 入口；`scripts/promote-admin.ts <email>` 提权
- **顺手修复**：账号删除与管理员删号统一清理 BackupCode/VerificationToken/CreditReminder 孤儿行；**测试基建再加固**——注册限流与中间件 API 限流全部 env 可配（`REGISTER_RATE_LIMIT`/`MIDDLEWARE_API_LIMIT`，CI/e2e 放大），根治"多轮跑测累计限流"类 flaky
- **验证**：单测 66/66（新增 admin 2 例：grant/clawback 不变量 + FIFO 顺序、超额回收拒绝）；e2e 8/8（新增 admin.spec：普通用户无入口且 /admin 跳回 → DB 提权 → Admin 入口出现 → 控制台给 30→130 积分）；tsc/build 通过；**容器实测**：`/api/admin/users` 未登录 401；compose 全栈 healthy

## 2026-08-11（公开 API + API Key 管理）

- **模型**：`ApiKey`（`pd_live_…` 原始值仅创建时展示一次，库中只存 SHA-256 哈希 + 展示前缀 + lastUsedAt/revokedAt；迁移 `20260811130000_api_keys`）
- **认证**：`lib/apikey.ts`——`authenticateApiKey` 解析 `Authorization: Bearer`，坏 key/已吊销统一 401（不泄露存在性）；`revokeApiKey` 立即失效
- **API v1**：
  - `POST /api/v1/images/generations`（prompt/model/quality/n≤4）→ Key 鉴权 → 每 Key 20 次/分钟 Redis 限流 → 前置内容安全过滤 → `createGenerationJob` 预扣积分走同一队列/审核/水印管线，返回 jobId 异步轮询
  - `GET /api/v1/images/generations/:id`（Key 鉴权 + 归属校验）→ 状态 + 预签名图片 URL（生产 S3 直出）
- **账户 Key 管理**：`POST/GET /api/account/keys`、`POST /api/account/keys/:id/revoke`；`/account/api` 页面（创建→仅一次展示+复制、列表前缀/最近使用/状态、吊销），工作台右上角 API Keys 入口
- **文档**：`docs/api.md`（curl 示例、参数、轮询、错误码、Key 管理）
- **验证**：单测 68/68（新增 apikey 2 例：哈希存储/前缀、鉴权/吊销/坏 key 拒绝）；e2e 9/9（新增 api-keys.spec：页面建 Key → Bearer 调 generations → 轮询 done + 1 图 → UI 吊销 → 401）；tsc/build 通过；**容器实测**：无 key/坏 key 调 v1 均 401；compose 全栈 healthy

## 2026-08-11（上线就绪收尾）

- **本地 CI 复刻**：`scripts/ci-local.sh` 按 GitHub Actions 分作业环境跑完整管道（prisma generate/migrate → tsc → 单测（unset EMAIL_VERIFY_AUTO，对齐 CI test-unit 作业）→ 生产构建 → seed + next start + worker → e2e（EMAIL_VERIFY_AUTO=1））；**实跑输出 `CI-LOCAL PASSED`**（69 单测 + 10 e2e）
- **发布运行手册** `docs/release.md`：env/密钥清单、部署、上线后冒烟命令（health/robots/安全头/注册验证/支付沙箱/API Key/管理台）、监控告警、回滚、上线首周观察项
- **安全头 e2e**：`/` 响应断言 CSP/HSTS/nosniff/X-Frame-Options
- **日志脱敏抽查**：observability 单测新增 redactSensitive 断言（sk-/AKIA/Bearer/预签名串全部打码）
- **修复**：auth-flow 单测对 `EMAIL_VERIFY_AUTO` 环境依赖不确定——测试内强制删除该变量（恢复原值），ci-local 按 CI 分阶段设置，单测与 e2e 两不误
- 单测 69/69、e2e 10/10、`CI-LOCAL PASSED`；compose 全栈 healthy

## 2026-08-11（品牌化 HTML 邮件 + 文案修正）

- **HTML 邮件模板**：`lib/mail-html.ts` 提供品牌化内联样式模板（头部 PixelDuo + 深色条、CTA 按钮、金额/积分表格、底部 Terms/Privacy），5 类邮件（验证/重置/收据/退款/到期提醒）全部 text+html 双版本；`Mailer.send` 增加可选 html 参数，SMTP 走 nodemailer `html` 字段，dev 模式日志带 HTML 预览；用户内容（商品名等）一律转义
- **文案修正**：注册页与落地页移除与现状不符的 "invite only"（注册本已开放）→ "no credit card required"
- **验证**：单测 74/74（新增 mail-html 5 例：链接/金额/日期文案/转义）；e2e 10/10；tsc/build 通过；**容器实测**：注册触发验证邮件，日志出现 `[mail:dev:html]` 完整 HTML 模板；compose 全栈 healthy

## 2026-08-11（留存横幅 + 限流规范 + 性能）

- **积分到期横幅**：`lib/credits.ts`（`listExpiringCredits`，14 天窗口，仅 PURCHASE/SUBSCRIPTION/ROLLOVER）+ `GET /api/credits/expiring` + 工作台横幅（"X 积分将于 N 天后过期"+ Top up 按钮跳定价页）——与到期邮件形成站内/邮件双触达
- **限流响应头**：`RateLimitResult` 增加 `remaining`（内存/Redis 双实现），`enforceRateLimit` 与 API v1 的 429 统一带 `RateLimit-Limit`/`RateLimit-Remaining` + `Retry-After`
- **性能**：落地页示例图加 `width/height` + `loading="lazy"`（避免 CLS、降低首屏负载）
- **验证**：单测 75/75（新增 credits 1 例：14 天窗口 + 仅付费来源 + daysLeft）；e2e 10/10；tsc/build 通过；**容器实测**：有效 Key 连续调 v1 第 21 次返回 429，响应头 `RateLimit-Limit: 20 / RateLimit-Remaining: 0 / Retry-After: 60`；compose 全栈 healthy

## 2026-08-11（双语落地页）

- **中文落地页**：`components/landing.tsx`（客户端组件）承载全部落地页文案并实现 EN/中文切换（导航/英雄区/双引擎/功能/价格/CTA/页脚全量翻译，语言偏好存 `localStorage.pd-lang`）；`app/page.tsx` 保留为薄服务端包装并继续导出 metadata（SEO 不受影响）
- **e2e**：新增语言切换用例（点"中文"→ 标题含"双模型"、导航出现"价格"）
- 单测 75/75、e2e 11/11、tsc/build 通过；compose 镜像重建、落地页 200、全栈 healthy

## 2026-08-11（FAQ + 品牌化错误页）

- **落地页 FAQ**：双语六问（计费/积分有效期/退款/内容安全/API/图片归属），折叠卡片展示，回答与条款/产品一致
- **品牌化错误页**：`app/not-found.tsx`（404）+ `app/error.tsx`（500），双语、带返回首页/工作台入口
- **验证**：单测 75/75、e2e 12/12（新增 FAQ 与 404 渲染断言）、tsc/build 通过；**容器实测**：落地页 200、任意不存在路径返回品牌化 404；compose 全栈 healthy
