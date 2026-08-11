# 调研发现（汇总）

> 各子代理详细报告见 `research/` 目录；此处为跨来源汇总。
> 最终产品大纲以 **PRODUCT_OUTLINE.md** 为准（v0.2）。

## 1. 官方 API 事实

### OpenAI gpt-image-2（来源：developers.openai.com/api/docs/pricing + /api/docs/guides/image-generation，核实 2026-08-10）

- 2026-04-21 发布，token 计费制（区别于旧模型的按张计费）：
  - 图像输入 token $8.00/1M，缓存输入 $2.00/1M，输出 $30.00/1M；文本输入 $5.00/1M、缓存 $1.25/1M（Batch 半价）
- 官方成本估算（含输出 token，按 1024×1024 / 1024×1536 / 1536×1024）：
  - Low: $0.006 / $0.005 / $0.005
  - Medium: $0.053 / $0.041 / $0.041
  - High: $0.211 / $0.165 / $0.165
- 支持任意分辨率、多轮编辑（输入图按高保真计 token，编辑成本更高）；不支持透明背景
- 相关型号：gpt-image-1.5（输出 $32/M）、gpt-image-1-mini（输入 $2.50/M、输出 $8/M，每张 Low $0.005~High $0.036）
- 流式 partial_images 每张 +100 输出 token

### Seedream 5（来源：docs.volcengine.com 套餐计费 + console.volcengine.com + 36kr/智东西报道 + Replicate/GMI Cloud/Empirio，核实 2026-08-10）

- 火山引擎国内版（人民币）：智能生图 Seedream 5.0 系列约 ¥0.1/张（限时优惠档），Seedream 4.0 ¥0.2、4.5 ¥0.25；5.0 Pro 官方 API ¥0.3/张（≤236 万像素）、¥0.6/张（>236 万像素），输入图首张免费、之后 ¥0.02/张
- 国际渠道（美元）：Seedream 5.0 Pro 约 $0.075/张（≤2.36MP）、$0.15/张（更高）；Replicate 上 1K $0.045、2K $0.09；Seedream 5.0 Lite $0.035/张
- 原生支持 2K/3K 输出（最高 3072×3072），带 web search 每张再加约 $0.0069

### DeepSeek（来源：api-docs.deepseek.com/quick_start/pricing，核实 2026-08-10）

- deepseek-v4-flash：输入 $0.14/1M（缓存命中 $0.0028）、输出 $0.28/1M，上下文 1M
- deepseek-v4-pro：输入 $0.435/1M（缓存命中 $0.003625）、输出 $0.87/1M
- 官方公告：近期将显著涨价，需关注
- 用途：Prompt 生成/优化成本可忽略（约 ¥0.001–0.01/次）

### 结论（单张生图边际成本）

| 模型 | 质量档 | 单张成本（约） |
|------|--------|----------------|
| gpt-image-2 | Medium | $0.04–0.05 |
| gpt-image-2 | High | $0.17–0.21 |
| gpt-image-1-mini | Medium | $0.011–0.015 |
| Seedream 5.0 Pro（国内） | ≤2.36MP | ¥0.3 ≈ $0.042 |
| Seedream 5.0 Pro（国际渠道） | ≤2.36MP | $0.075 |
| Seedream 5.0 Lite | 标准 | $0.035 |

## 2. 竞品格局

### 海外头部
- Midjourney $10/30/60/120 月，GPU 小时制，成本黑盒；Ideogram 积分制（10/周免费，Basic $7-8/400 积分，Plus $16-20/1000）；Leonardo token 制（$12/8.5k）；Krea compute units 制（$9/5k）；Recraft credits 制（$12/1000，多模型聚合+SVG，最接近我们的形态）；Firefly credits 制（$9.99 起，团队 4k-50k credits）；Freepik credits 制（$5.75 起 8k credits，30+ 模型）
- 共同弱点：计费黑盒、免费额度缩水（Ideogram 10/天→10/周）、变相涨价（即梦 2026-04 三次调价积分砍半）、单一模型绑定、无 prompt 助手、消费者 UI 与 API 割裂

### 国内/平台型
- 即梦 ¥329/949/2599 年费，2026-04 涨价引众怒；通义万相 API ¥0.2/张（国际 $0.0287）；LiblibAI 月卡 ¥38/年卡 ¥388、规则复杂投诉多；SeaArt 免费 130 精力/天，$5.99-29.99；TensorArt Pro $9.9/天 300-500 credits；fal/Replicate 按张透明（GPT Image 2 $0.02 起、Seedream V4 $0.03-0.04、FLUX $0.025）

### 开源
- 可复用：nano-banana-generator（Next.js+Stripe+credits，★★★★★ 形态最接近）、Imago（Next.js+Supabase+Stripe 积分，★★★★☆）、pixie（Rust Worker credits，★★★☆☆）、vercel-labs/ai-sdk-image-generator（多 provider 并行对比，★★★★☆）
- 不可复用/需自研：双模型路由、成本预览、按模型差异化计分、prompt 助手、i18n、内容审核队列、支付 Provider 抽象
- 自托管引擎（ComfyUI/SD WebUI/InvokeAI/Fooocus）仅作 v2+ 远期选项；AGPL/GPL 许可需规避（InvokeAI Apache-2.0 最安全）

## 3. 差异化机会

- 透明按张计费 + 价格稳定承诺（直击即梦/Ideogram 变相涨价痛点）
- 双强模型自由切换与一键对比（GPT Image 2 × Seedream 5，成本差真实存在）
- DeepSeek Prompt 助手免费（成本 <$0.0005/次，可免费增值）
- 出海级支付合规（Paddle MoR 起步）+ 中英双语体验
- 灵感库 SEO 获客 + 一键复用（低成本增长）

## 4. 支付与合规（主代理）

- 大陆主体 Stripe 不可用 → MVP 用 Paddle（MoR 5%+$0.5）或 Creem（~3.9%）；Lemon Squeezy 2026 不再收新大陆开发者，不推荐
- 中后期：注册 HK/SG/US 公司转 Stripe（~2.9% + Stripe Tax），省费率且接 Apple/Google Pay
- 合规：OpenAI 转售需披露 AI 生成 + 保留 C2PA；火山/BytePlus 注意内容审核与出口管制；平台需 DMCA 与内容安全流程
- 开源参考：nano-banana-generator（Next.js+Stripe+credits+Prisma，最贴近）、Imago（Next.js+Supabase+Stripe 积分）、pixie（Rust+Cloudflare Worker+credits）→ 详见 research/payment_research.md

## 5. 2026-08-11 补充（用户决策后的双市场修正）

### 支付（双轨）
- Paddle 是 Merchant of Record（收单+税务+合规）：卖家无需外国卡（买家侧支付方式含银行卡/PayPal/Apple Pay/Google Pay/部分本地方式含 Alipay）；大陆主体/个人开户有审核门槛，能否开通与结算以官方实际注册为准
- 国内收款：支付宝/微信支付官方商户号需营业执照（企业或个体工商户）+ 域名 ICP 备案 + 法人银行卡/对公账户；SaaS 虚拟商品类目需提交经营场景
- 结论：国内轨 = 支付宝+微信（个体户+ICP 备案）；海外轨 = Paddle 起步 → 公司化后 Stripe

### 国内 AIGC 合规（面向境内公众提供生成图片服务）
- 《生成式人工智能服务管理暂行办法》+《互联网信息服务深度合成管理规定》：AI 内容显式标识、安全评估、生成式 AI 服务备案/算法备案（周期约 1–3 个月）；网站 ICP 备案
- OpenAI API 大陆不可直连且不符合国内备案语境 → 国内版以 Seedream（火山引擎）为主

### 已拍板决策
- 目标市场：国内 + 海外（欧美优先），EN+ZH 双语
- 积分：充值积分 12 个月有效；订阅月配额未用完部分按 30% 结转下月（仅下月有效）
- 免费额度：注册 30 分 + 每日签到 2 分（含水印）
- 内容边界：主站严格 SFW
