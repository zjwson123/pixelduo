# PixelDuo PRD v0.1（MVP 范围）

> 配套文档：产品大纲 [PRODUCT_OUTLINE.md](../../PRODUCT_OUTLINE.md)（v0.6）· 视觉原型 `designs/pixelduo/` · 黑暗测试 [report.md](../../research/darktest/report.md)
> 状态：与 UI 原型同步迭代中，待用户评审后定稿。

## 1. MVP 一句话

免费 Beta（邀请制）的双引擎文生图工作台：GPT Image 2 × Seedream 5 自由切换/对比，生成前透明计费，DeepSeek Prompt 助手，模板库与个人画廊；积分与订阅逻辑真实实现，支付为"壳子"（Paddle/支付宝/微信可切换接口 + 模拟结账）。

## 2. MVP 用户故事与验收标准

### 2.1 生图核心

- **US-1 双模型生成**：用户输入 prompt，选择模型（gpt-image-2 / seedream / both）、质量档、数量后生成。
  - 验收：both 模式并排输出两引擎结果；结果卡片标注模型与消耗积分；失败自动退积分并提示重试一次。
- **US-2 成本预览**：生成前展示"本次消耗 X 积分 ≈ $Y"。
  - 验收：成本随模型/质量/数量实时变化；余额不足时禁用生成并引导充值；扣费与预览一致（同一套 estimateCost 函数）。
- **US-3 异步队列**：生成任务排队、进度推送。
  - 验收：任务状态（queued/running/done/failed）实时可见；分模型延迟参考 seedream <30s / gpt medium <60s / gpt high <180s。

### 2.2 Prompt 助手（DeepSeek）

- **US-4 扩写/翻译/风格化**：一句话 → 生产级英文 prompt。
  - 验收：中英互译、风格追加、负面词建议；免费档每日限次（如 10 次），订阅不限；单次成本 <$0.001。

### 2.3 模板与画廊

- **US-5 模板库**：分类示例一键复用。
  - 验收：点击模板自动填充 prompt + 模型 + 参数；MVP 至少 8 类 × 20 例（人工精选）。
- **US-6 个人画廊**：历史可查、可复用、可下载。
  - 验收：每条记录含 prompt/模型/质量/消耗积分/时间；一键"再生成"。

### 2.4 积分与订阅（真实逻辑）

- **US-7 积分账本**：充值/赠送/预扣/结算/退款/过期全流水。
  - 验收：余额 = 流水汇总；预扣→成功结算/失败退款为原子事务；防并发超扣。
- **US-8 订阅配额**：月配额 + 30% 结转。
  - 验收：Pro 2000 分/月，未用完部分按 30% 结转下月（仅下月有效，不再滚动）；年付 8 折。
- **US-9 免费档**：注册 30 分 + 每日签到 2 分，图片含水印。
  - 验收：签到有防刷（设备指纹 + 频率限制）；免费与付费积分不混算抵扣。

### 2.5 支付壳子（MVP 不接真实收款）

- **US-10 支付抽象**：PaymentProvider 接口（Paddle / Alipay / WeChatPay / Stripe），开发环境 MockProvider 返回成功。
  - 验收：切换 Provider 只需配置；webhook 幂等处理订阅/充值/退款事件。
- **US-11 结账 UI**：定价页 + 结账弹窗（支付方式选择）。
  - 验收：Beta 模式明确提示"模拟到账，不产生真实扣款"；正式收费时只换 Provider 与风控。

## 3. MVP 范围外（明确不做）

- 真实支付、主体注册、ICP/AIGC 备案（P3 商业化阶段）
- 图生图/局部重绘/放大（v1）
- 社区画廊、Prompt 市场、邀请返利（v1）
- API 转售、团队版、ComfyUI 专业模式（v2）
- 移动原生 App（先 PWA）

## 4. 技术要点

- 技术栈：Next.js 15 + Postgres/Prisma + Redis/BullMQ + R2/CDN + Clerk（认证）+ next-intl（EN/ZH）
- 上游抽象：`ImageProvider { estimateCost(); generate(req) }`，OpenAIProvider（ModelVerse/官方）+ SeedreamProvider（火山方舟/BytePlus）双实现；both 模式并行调用
- 积分引擎：账本式（double-entry），参考 pixie / @credit-engine / Imago
- 内容安全：生成前 DeepSeek 分类器 + 关键词；生成后 NSFW 检测；举报 + 申诉通道
- 水印口径：seedream 自带"AI生成"合规标识（保留）；平台角标作为免费档权益位（付费去平台角标）
- 监控：Sentry + PostHog；上游成本/毛利看板（按模型×质量档）

## 5. MVP 指标

| 指标 | 目标 |
|---|---|
| 注册 → 首次生成转化率 | ≥ 40% |
| 生成成功率 | ≥ 98% |
| 免费→付费转化（P3 开放后） | ≥ 3% |
| 次月留存 | ≥ 25% |
| 毛利率（商业化后） | ≥ 60%（Lite 档混合） |

## 6. 待评审

- 视觉与交互：以 designs/pixelduo/ 原型为准，重点看 Create 工作台与定价页
- 积分单价：seedream 6 / gpt medium 8 / gpt high 26–28（黑暗测试校准，上线前按真实账单复核）
- 免费档水印口径：平台角标 vs seedream 合规标识的展示策略
