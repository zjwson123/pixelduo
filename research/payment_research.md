# 出海支付与合规调研（主代理支付线）

> 调研日期：2026-08-10。来源见各条目。

## 1. 支付方案（2026 现状）

| 方案 | 费率 | 税务/合规 | 中国大陆主体可用性 | 适用阶段 |
|---|---|---|---|---|
| Stripe | ~2.9% + 固定费（Stripe Tax ~0.5% 可选） | 你是 seller of record，自担 VAT/税 | ❌ 大陆主体不能直接开通，需 HK/SG/US 公司 | 公司化后（Stripe Atlas 是常见路径） |
| Paddle（MoR） | 5% + $0.50 | Paddle 代缴全球税，200+ 国家，30+ 币种 | ✅ 主流选择（注册时验证主体资格） | 无海外公司时的首选 |
| Lemon Squeezy | 5% + $0.50 | 同上 | ⚠️ 2024 被 Stripe 收购；2026 起不再接受新独立开发者（大陆）申请；路线图安静 | 不推荐新项目 |
| Creem / Waffo Pancake | ~3.9% 档 | MoR | ✅ 面向独立开发者 | 低费率 MoR 替代 |
| 加密货币（Coinbase Commerce / NowPayments） | ~1% | 自行处理 | ✅ | 补充渠道 |

参考：chinaabroadguide.com（大陆公司 Stripe 方案汇总 2026-06）、dyordo.com 独立开发者海外收款指南 2026、valueaddvc.com（Stripe/Paddle/LS 对比）、fungies.io（LS 被收购后状态，2026-04）。

**结论**：MVP 阶段用 Paddle（或对比 Creem 费率）做 Merchant of Record，无需先注册海外公司；月 GMV 稳定后评估注册香港/新加坡/美国公司转 Stripe（省 ~2pct 费率，接 Apple/Google Pay 等本地支付）。

## 2. 上游 API 合规要点

- OpenAI：转售/白标在其 API 使用政策允许范围内，但需披露 AI 生成内容、保留 C2PA 元数据、不得规避内容安全机制；合规细则上线前需以最新政策复核。
- 火山引擎/BytePlus：国内版需对接内容安全（模型自带审核能力）；海外版注意数据驻留、出口管制（模型权重/服务地区限制）。
- 平台自身：儿童安全、暴力/色情过滤、侵权（名人肖像/风格模仿）、DMCA 下架流程、用户条款中写明生成内容商用授权归属与违规内容删除权。

## 3. 开源计费/生图 SaaS 参考（可复用的脚手架）

- **nano-banana-generator**（SamurAIGPT）：production-ready Next.js SaaS，文生图 + 多参考图编辑；Stripe billing + credits + NextAuth + Prisma 开箱即用。≈ 最贴近本产品形态的开源参考。
- **Imago**（tenngoxars）：Next.js + Supabase + Stripe，结构化 prompt 构建、积分系统、充值弹窗、webhook 扣减、PWA。
- **pixie**（guitaripod）：Rust + Cloudflare Worker 的 OpenAI 兼容生图服务，credits 计费、用量追踪，低/中/高质量档 4-6 credits（$0.04-0.06）。
- **credit-engine SDK**（npm）：AI 产品的 usage-based credits 即插即用组件。

参考：github.com/SamurAIGPT/nano-banana-generator、github.com/tenngoxars/Imago、github.com/guitaripod/pixie、npm @credit-engine/sdk。

## 4. 支付产品设计要点

- 币种：默认 USD；Paddle 30+ 币种本地化展示。
- 订阅：包月/包年（年付 8 折常见），Stripe/Paddle 均支持 webhook 驱动的订阅生命周期。
- 积分：储值型积分包（随用随扣，可过期/不过期两种策略），与订阅配额（每月 N 张，月底清零或可结转）双轨；业界两种都常见，属共创决策点。
- 税务：MoR 模式自动代缴；Stripe 模式需 Stripe Tax + 注册地评估。

