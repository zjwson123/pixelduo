# perf/bench —— 测速与护栏

口径见 `../基线.md`。这里只讲命令和坑。

## 命令

```bash
# 常规测量（一个版本）：落地页 + 工作台，各 10 次
bash perf/bench/run.sh http://localhost:3000 perf/bench/base

# 配对测量（结论用这个）：基线版和优化版同时起着，A/B 交替
bash perf/bench/paired.sh http://localhost:8123 http://localhost:3000 perf/bench/paired

# 首屏拆解：谁卡在关键路径上
python3 perf/bench/breakdown.py --url http://localhost:3000/ --ready "$LANDING_READY"

# 三件护栏
python3 perf/bench/golden.py capture --url <url> --out <json>     # SEO/文案黄金
python3 perf/bench/golden.py diff --a <base.json> --b <new.json>
python3 perf/bench/visual.py capture --url <url> --out <prefix>   # 视觉回归（几何+像素）
python3 perf/bench/visual.py diff --a <base> --b <new>
python3 perf/bench/smoke.py --base <url> [--base-b <url>]         # 功能冒烟

# 棘轮：p75 只许降不许升
python3 perf/bench/ratchet.py init  --result <json> --ceilings perf/bench/ceilings.json --label <名字>
python3 perf/bench/ratchet.py check --result <json> --ceilings perf/bench/ceilings.json --tolerance 0
```

`perf/bench/session.json` 是 `mksession.py` 造的一次性登录态（注册接口有 10 次/小时/IP 的上限，
所以只造一次、反复用）。工作台必须带它 —— 未登录访问 `/studio` 是 302 到 `/login`，测出来的
是登录页，数字会好看得毫无意义。

## 为了在这个项目上跑通，对 skill 原版脚本做的四处改动

**1. 判定结果写进 DOM，用选择器等（原版用 `wait_for_function` 的字符串谓词）。**
这个应用带严格 CSP（`script-src 'self' 'unsafe-inline'`，没有 `'unsafe-eval'`）。Playwright 的
字符串谓词走 eval：**只要谓词当前不成立，它抛的是 CSP 的 EvalError 而不是继续轮询**，
于是每一个还没到「能用」的页面都会被记成失败。现在 init script 在判定成立的瞬间给
`<html>` 打 `data-flash-ready`，测量端 `wait_for_selector` 等它 —— 走 DOM 观察，不改页面 CSP。

**2. `--dpr`。** 原版固定 deviceScaleFactor=1。落地页的对比图在 retina 上会走 `srcset` 的 2x 档，
只测 dpr=1 完全看不见那一档的体积代价（实测 2x 档一度占首屏图片字节的 61%）。默认仍为 1，
配对测量会 dpr=1 和 dpr=2 各跑一组。

**3. 判定轮询加了 100ms 定时兜底。** 原版只用 `requestAnimationFrame`。这台机器负载高时
rAF 会长时间不触发（主线程其实是空的），实测有整轮 30s 超时。`setInterval` 只是兜底检查，
判定条件与时间源（`performance.now()`）都不变，最坏多 100ms 粒度；两个版本用法一致。

**4. 复用 context，而不是每轮新建/销毁。** 带着 4G 限速 close 一个还有几 MB 请求在飞的
context，会把浏览器的网络服务卡死 —— 实测约 1/6 的轮次单轮墙钟 **900s**（同一台机器、同
一个页面，不限速时 8/8 秒过）。卡死之后每个 CDP 调用各等 180s（protocolTimeout），一轮能
拖十几分钟，还会让后续轮次一起变慢。现在一个浏览器 + 一个 context 反复用，每次测量前
`clearBrowserCache` + 清 origin 存储，并给每个 CDP 调用单独封顶。

   冷缓存语义怎么保持不变：会话级 `Network.setCacheDisabled: true` 让每个请求都回源，
   再叠加每次的清缓存与清存储。三种口径在同一台机器上的实测值一致（6691.4 / 6692.1 /
   6692.8ms，差 1.5ms），可以认为这个偏差不影响结论。
