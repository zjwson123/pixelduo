# 任务计划：AI 文生图 SaaS 产品共创（商用级、出海）

## 目标
与用户共创一个商用级、可出海、可盈利的 AI 文生图 Web 产品：
底层调用 gpt-image-2 / Seedream 5（双模型差异化定价），DeepSeek 做 Prompt 助手，
积分 + 会员订阅双轨制，完整支付链路。

## 阶段

- [x] 1. 探索项目上下文（工作区为空，greenfield 项目）
- [x] 2. 官方 API 调研：gpt-image-2（OpenAI）、Seedream 5（火山引擎）、DeepSeek 定价与能力（另含支付链路调研 research/payment_research.md）
- [x] 3. 竞品调研 A：海外头部（Midjourney / Leonardo / Ideogram / Krea / Recraft / Firefly 等）→ 子代理未产出，主代理补完
- [x] 4. 竞品调研 B：国内与平台型（即梦 / 通义万相 / TensorArt / SeaArt / LiblibAI / fal.ai / Replicate 等）→ 子代理产出支付部分，产品部分主代理补完
- [x] 5. 竞品调研 C：GitHub 开源生态（ComfyUI / SD WebUI / InvokeAI / 开源 SaaS 模板）→ 子代理完成 research/oss-ecosystem.md
- [x] 6. 综合分析：竞品弱点、差异化机会、商业模式、定价策略、出海合规
- [x] 7. 撰写《产品大纲》文档 → PRODUCT_OUTLINE.md（v0.2，已合并子代理草稿 + 官方定价校准）
- [ ] 8. 向用户呈现大纲 + 关键决策点（下一轮共创）

## 关键决策记录

- 1 积分 = $0.01；Seedream 6 分 / gpt 标准 8 分 / gpt 高清 24 分（待按真实 key 成本复核）
- 支付：MVP 用 Paddle（MoR），支付 Provider 抽象接口，公司化后切 Stripe
- 内容边界：主站严格 SFW（支付合规红线）
- 差异化定位：双模型透明计费 + DeepSeek Prompt 助手 + Prompt 画廊/市场
- 低价档候选：gpt-image-1-mini（$0.011–0.015/张）改善免费档成本

## 错误记录

| 错误 | 尝试 | 解决 |
|------|------|------|
| 子代理 A（海外竞品）长时间无产出 | 发消息催办 | 中断后主代理自行补完调研 |
| 子代理 B（国内+支付）报告未完整落盘 | followup 催办 | 支付部分已落盘，产品部分主代理补充 |
| 创建新子代理失败（线程上限） | 复用已有代理 | 复用上一轮已存在的 3 个代理 |
