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
