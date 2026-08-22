# GitHub 开源生态调研（research_oss 子代理交付）

> 调研日期：2026-08-10。本报告回答三个问题：①自托管生图引擎生态现状；②可复用的开源 SaaS 模板/脚手架；③对「双模型 AI 生图 SaaS」的工程决策结论。

## 1. 自托管生图引擎生态（远期成本护城河，非 MVP 选项）

| 引擎 | 许可 | 定位 | 对商业 SaaS 的意义 |
|---|---|---|---|
| ComfyUI | GPL-3.0（需核实） | 节点式工作流引擎，HTTP API（默认 8188 端口），10k+ 自定义节点 | 事实上的「AI 工作流后端」标准；有商业封装实践（comfy-server、RunPod 模板）；支持 workflow JSON 版本化、LoRA/ControlNet/局部重绘。缺点：无账号/计费/限流体系，GPU 运维与高并发成本高 |
| AUTOMATIC1111 SD WebUI | AGPL-3.0 | 最老牌 Web UI，40k+ stars | 生态大但单例架构、性能一般、API 简陋；AGPL 传染性对闭源商用不友好 |
| InvokeAI | Apache-2.0 | 专业级节点编辑器 + 更现代 UX | 许可友好，可作为自托管高级模式参考，但生态小于 ComfyUI |
| Fooocus | GPL-3.0 | 面向新手的一键式本地生图 | 单机体验好，不具备多用户 SaaS 能力 |

**结论**：自托管 GPU 栈是「绕开上游 API 依赖」的远期选项，但 MVP 不应碰——GPU 运维、并发调度、扩缩容成本远超按 API 计费；建议 v2 之后再评估「API 为主 + 自托管为辅」的混合路由（用 ComfyUI 做 FLUX/SD 系列工作流）。

## 2. 可直接复用的开源 SaaS 模板/脚手架

| 项目 | 技术栈 | 自带能力 | 与本产品的契合度 |
|---|---|---|---|
| [nano-banana-generator](https://github.com/SamurAIGPT/nano-banana-generator)（SamurAIGPT） | Next.js + Stripe + NextAuth + Prisma | 文生图 + 多参考图编辑、Stripe billing、积分系统、生产级 SaaS 结构 | ★★★★★ 形态最接近；但绑定单一模型与 Stripe，换 Paddle + 双模型需改造 |
| [Imago](https://github.com/tenngoxars/Imago) | Next.js + Supabase + Stripe | 结构化 prompt 构建、积分系统（充值弹窗 + webhook 扣减）、PWA、暗色 UI；已上 Product Hunt | ★★★★☆ 积分/支付链路实现清晰，适合做前端与计费参考 |
| [pixie](https://github.com/guitaripod/pixie) | Rust + Cloudflare Worker | OpenAI 兼容生图服务、credits 计费（低/中/高 = 4–6 credits）、用量追踪 | ★★★☆☆ 后端积分引擎参考（账本式扣减、防超扣） |
| [vercel-labs/ai-sdk-image-generator](https://github.com/vercel-labs/ai-sdk-image-generator) + [TencentEdgeOne/vercel-ai-image-generator](https://github.com/TencentEdgeOne/vercel-ai-image-generator) | Next.js + Vercel AI SDK | 多 provider（OpenAI DALL·E、fal FLUX、Fireworks、Replicate），单输入多 provider 同时生成 | ★★★★☆ 「双模型 A/B 对比」功能的现成参考实现 |
| [flux-kontext-template](https://github.com/CharlieLZ/flux-kontext-template)（CharlieLZ） | Next.js + fal + Stripe/Creem | 中文套壳模板、fal 接入、充值 | ★★☆☆☆ 中文教程生态样例 |
| [pixio-api-starter](https://github.com/afarhadi99/pixio-api-starter) | Turborepo monorepo + Supabase + Stripe + Expo | 订阅 SaaS + AI 媒体生成 + Web + 移动端 | ★★★☆☆ 若未来做移动端可参考 monorepo 结构 |
| [credit-engine SDK](https://www.npmjs.com/package/@credit-engine/sdk) | npm 包 | AI 产品 usage-based credits 即插即用 | ★★★☆☆ 积分账本组件，可替代自研 |

## 3. 工程决策结论

1. **不要从零搭骨架，也不建议整仓 fork**：以 `Imago`/`nano-banana-generator` 为「结构与积分/支付实现」参考，核心业务层自建。模板能省 2–3 周脚手架时间，但我们的差异化点——双模型路由、生成前成本预览、按模型差异化计分、DeepSeek Prompt 助手、成本看板、内容审核队列、国际化——**模板全部没有，必须自研**，这反而说明「模板 + 差异化自研」是可行的快速路线。
2. **模板的共性缺陷恰好是竞品空白**：单一 provider 绑定、无成本/毛利看板、无多模型差异化计费、无 prompt 助手、无 i18n、无内容安全队列、积分规则简单（无过期/结转策略）。这些缺陷直接映射为我们的差异化功能清单。
3. **支付层注意**：模板几乎都写死 Stripe；MVP 若走 Paddle/Creem（MoR）需自建 webhook 适配层——建议把「支付 Provider 抽象接口」列为架构一等公民（Stripe/Paddle/Creem 可切换）。
4. **许可合规**：自托管引擎中 AGPL（SD WebUI）对闭源商用有传染性风险，GPL（ComfyUI/Fooocus）同样需谨慎；InvokeAI（Apache-2.0）最安全。模型侧：FLUX.1 schnell 为 Apache-2.0，FLUX.1 dev 为非商用许可，SD3.5 为社区许可（营收超 100 万美元需付费）——若远期自托管，许可矩阵必须提前列清楚。以上许可情况需以各仓库 LICENSE 最新文本核实。
5. **ComfyUI 作为远期高级模式**：其 workflow 生态（角色一致性、ControlNet 构图、局部重绘）可作为 v2+ 的「专业模式」卖点，与我们的 API 双模型形成「托管 API（易用）+ 自托管工作流（高级）」双层产品。

## 4. 对我们路线图的具体建议

- MVP：Next.js + Postgres/Prisma + Paddle（MoR）+ 自建积分引擎（参考 pixie/credit-engine 的账本式设计）+ 上游 ImageProvider 抽象层（OpenAI / BytePlus ModelArk 双实现）+ 基础内容审核。
- 前端多模型对比区：直接参考 vercel-labs/ai-sdk-image-generator 的「单输入多 provider 并行生成」交互。
- 开源贡献策略：可把「成本预览 + 按模型差异化计分」沉淀为独立开源组件，反向获取开发者流量（同时为 API 转售铺路）。

## 来源

- github.com/SamurAIGPT/nano-banana-generator（2026-07 更新）
- github.com/tenngoxars/Imago（2026-01；Product Hunt 上线）
- github.com/guitaripod/pixie
- github.com/vercel-labs/ai-sdk-image-generator
- github.com/TencentEdgeOne/vercel-ai-image-generator（2026-03）
- github.com/CharlieLZ/flux-kontext-template（2026-03 v0.1.0）
- github.com/afarhadi99/pixio-api-starter（2026-06）
- runflow.io/blog/comfyui-api-developer-guide（2026-04）；deepwiki.com/ComfyUI External API Integration（2026-08）
- npm @credit-engine/sdk
