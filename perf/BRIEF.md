# 性能冲刺简报：PixelDuo

## 你的职责

负责 PixelDuo 打开和使用的速度：先测基线，再一步步优化，每一步都用测量证明，赢下来的用棘轮锁住。
主动提出改进，但用户看得见的变化和上线由人决定。

## 核心操作与「能用」的定义

| 操作 | 页面 | 起点 | 终点（真的能用） | 判定表达式 |
|---|---|---|---|---|
| 打开落地页 | `/` | 导航开始 | 首屏标题可见、对比滑块两张图都解码完成、主 CTA 可点 | `(() => { const h = document.querySelector(".hero h1"); if (!h \|\| h.offsetParent === null) return false; const imgs = document.querySelectorAll(".compare img"); if (imgs.length < 2) return false; for (const i of imgs) if (!i.complete \|\| i.naturalWidth === 0) return false; return !!document.querySelector(".hero-cta a"); })()` |
| 打开工作台 | `/studio` | 导航开始 | 提示词输入框可见可输入，且 `/api/me` 已返回（余额已渲染） | `(() => { const ta = document.querySelector("textarea"); if (!ta \|\| ta.offsetParent === null) return false; const bar = document.querySelector(".costbar"); if (!bar) return false; return !bar.querySelector(".warn"); })()` + 打字校验 `textarea` |

判定里的两条附加条件是刻意的：

- 落地页要求**两张对比图解码完成**。这个页面的「能用」就是「看得见产品长什么样」，
  图片没到就还不算能用 —— 否则把图片延后加载能把数字做得很漂亮，用户却什么都没看到。
- 工作台要求 **`/api/me` 已返回**（`.costbar` 里不再是 `Insufficient credits`）。
  只等输入框会出现「没水合的空壳也算达标」的假象：那种状态点点看生成是没反应的。

## 不能动的东西

- **视觉**：布局、配色、字体、动效节奏不变。唯一允许的例外是首屏图片的**分辨率与编码**
  （见下），因为它同时是最大的性能开销和用户能感知的画面质量 —— 这一条要用户拍板。
- **功能**：双引擎同题对比、拖动分割线、模板/探索、生成与退款流程、账本、定价页、批量与视频。
- **SEO / 内容**：`title`、`description`、`openGraph`、`twitter`、`robots`、canonical、页面可见文案逐字节一致；
  锚点（`#how` / `#gallery` / `#pricing` / `#faq`）与所有链接目标不变。落地页是 SEO 入口，文案不能动。
- **不改的东西**：路由与 URL 结构、`/api` 契约、CSP 与安全响应头（`next.config.mjs` 的 headers 原样保留）。

## 目标

- 主指标：**落地页 `/` 的「打开到能用」p75 从基线降到一半以下**（降幅 ≥50%）。
- 次指标：工作台 `/studio` 的「打开到能用」p75 不退化，能降则降。
- 杠杆指标（确定性计数，用来当每步的闸门）：首屏请求数、JS/CSS/图片字节数、主线程长任务总时长。
- 测量口径：`references/measurement-protocol.md` 的**主口径 Fast 4G**（往返 20ms、下行 4Mbps、上行 3Mbps，
  对所有请求生效，含本地服务），冷缓存，每组 ≥10 次，报 p50 / p75 / p95。
- 上线前另做一次**配对测量**（基线版与优化版同时起服务，A/B/A/B 交替）。

## 上线与回滚

- 谁批准上线：**用户**（zjw）。本冲刺只产出本地改动与报告，不做部署、不推送、不改 DNS/CDN/托管平台配置。
- 部署方式（现状，供上线时参考）：`docker compose -f docker-compose.prod.yml` 构建镜像 + Caddy 反代（`encode gzip`）。
- 回滚办法：`git revert <commit>` 后重新构建部署；图片素材改动集中在 `public/`，回退同样是 revert。
- 放行条件（可由用户预先给定）：护栏全绿（视觉回归 / 功能冒烟 / SEO 逐项一致 / 棘轮不升）且配对测量确实变快。

## 开工时的已知事实（2026-09-26 侦察）

- 落地页 `X-Nextjs-Prerender: 1` + `X-Nextjs-Cache: HIT`，HTML 16.7KB —— 服务端不是瓶颈，瓶颈在资源体积。
- 首屏关键路径字节 ≈ **1.08MB**（gzip 后）：JS 259KB + CSS 6.7KB + **两张首屏 JPEG 796KB** + HTML 16.7KB。
  两张对比图是小图放大后当 LCP 用的：`case1.jpg` 941×1672 / 634KB，`case225.jpg` 600×900 / 162KB，
  都是原图直出（`<img>` 无 `srcset`、无 `width/height`）。
- 全站没有 `next/image`，`public/showcase` 里最大的 `case338.jpg` 是 3072×1024 / 1052KB。
- 字体全部为本机字体（无外链字体、无 `@font-face`）。
- 压缩：Next 默认 gzip，Caddy 再叠一层 `encode gzip`；本地量到的原始字节约为 gzip 后的 3.2 倍。
