#!/usr/bin/env python3
"""闪电.skill 测速：冷缓存下测「打开到能用」。

支持网络与 CPU 限速、「能用」判定表达式、打字校验、A/B 两个版本交替配对测量。
依赖：pip install playwright && python3 -m playwright install chromium
"""
import argparse
import asyncio
import json
import statistics
import sys
import time
import urllib.parse

from playwright.async_api import async_playwright

# 网络档：延迟单位 ms，吞吐单位 字节/秒
PROFILES = {
    "none": None,
    "fast4g": {"offline": False, "latency": 20,
               "downloadThroughput": 4 * 1024 * 1024 / 8,
               "uploadThroughput": 3 * 1024 * 1024 / 8},
    "slow4g": {"offline": False, "latency": 150,
               "downloadThroughput": 1.6 * 1024 * 1024 / 8,
               "uploadThroughput": 750 * 1024 / 8},
}

INIT_JS = """
(() => {
  const READY = () => { try { return !!(%s); } catch (e) { return false; } };
  const f = window.__flash = { ready: null, lcp: null, longtask: 0 };
  try {
    new PerformanceObserver(l => { for (const e of l.getEntries()) f.lcp = e.startTime; })
      .observe({ type: 'largest-contentful-paint', buffered: true });
  } catch (e) {}
  try {
    new PerformanceObserver(l => { for (const e of l.getEntries()) f.longtask += e.duration; })
      .observe({ type: 'longtask', buffered: true });
  } catch (e) {}
  const mark = () => {
    if (f.ready !== null) return true;
    if (!READY()) return false;
    f.ready = performance.now();
    // Mirror readiness into the DOM. The app ships a strict CSP
    // (script-src 'self' 'unsafe-inline', no 'unsafe-eval'), and Playwright's
    // string-predicate wait_for_function evaluates through eval: the moment
    // the predicate is still false it throws a CPS EvalError instead of
    // polling. Waiting on this attribute uses DOM observation, so the page
    // keeps its real CSP and the number stays honest.
    try { document.documentElement.setAttribute('data-flash-ready', '1'); } catch (e) {}
    return true;
  };
  const loop = () => { if (!mark()) requestAnimationFrame(loop); };
  requestAnimationFrame(loop);
  // rAF 在负载高的机器上会长时间不触发（实测有整轮 30s 超时的），
  // 而主线程其实一直是空的。加一条 100ms 的定时兜底：同一次判定、同一个
  // performance.now() 时间源，只是最坏情况多 100ms 粒度。两边用它，公平。
  setInterval(mark, 100);
})();
"""

COLLECT_JS = """
() => {
  const nav = performance.getEntriesByType('navigation')[0] || {};
  const fcp = performance.getEntriesByName('first-contentful-paint')[0];
  const res = performance.getEntriesByType('resource');
  const bytes = {};
  for (const r of res) {
    const k = r.initiatorType || 'other';
    bytes[k] = (bytes[k] || 0) + (r.transferSize || 0);
  }
  const slowest = res.slice().sort((a, b) => b.responseEnd - a.responseEnd).slice(0, 5)
    .map(r => ({ name: r.name.slice(0, 120), responseEnd: Math.round(r.responseEnd) }));
  return {
    ready: window.__flash.ready, lcp: window.__flash.lcp, longtask: window.__flash.longtask,
    fcp: fcp ? fcp.startTime : null,
    dcl: nav.domContentLoadedEventEnd || null, load: nav.loadEventEnd || null,
    requests: res.length + 1,
    bytes_total: res.reduce((s, r) => s + (r.transferSize || 0), 0) + (nav.transferSize || 0),
    bytes_by_type: bytes, slowest: slowest,
  };
}
"""


def pct(values, p):
    v = sorted(x for x in values if x is not None)
    if not v:
        return None
    if len(v) == 1:
        return round(v[0], 1)
    return round(statistics.quantiles(v, n=100, method="inclusive")[p - 1], 1)


async def bounded(coro, seconds):
    """CDP 卡住时，playwright 会等到 protocolTimeout（默认 180s）才抛。
    一次卡顿能连累后面每个调用，凑出十几分钟的墙钟。这里给每个调用单独封顶。"""
    try:
        return await asyncio.wait_for(coro, timeout=seconds)
    except Exception:
        return None


class Runner:
    """一个浏览器 + 一个 context + 一个 page 反复用。

    为什么不每轮新建 context：带着 4G 限速 close 一个还有几 MB 请求在飞的 context，
    会在约 1/6 的轮次里把浏览器的网络服务卡死 —— 实测单轮墙钟 900s（不限速时 8/8
    秒过），而且卡死后的每次 CDP 调用各等 180s，一轮能拖十几分钟。

    「冷缓存」由 Network.setCacheDisabled 保证：整个会话里每个请求都回源，不走缓存；
    每次测量前再 clearBrowserCache + 清 origin 存储，等价于新上下文的那部分语义。
    """

    def __init__(self, playwright, args):
        self.p = playwright
        self.args = args
        self.launch_args = []
        if args.proxy:
            self.launch_args += [f"--proxy-server={args.proxy}",
                                 "--proxy-bypass-list=127.0.0.1,localhost,<local>"]
        self.browser = None
        self.ctx = None
        self.page = None
        self.cdp = None

    async def start(self):
        self.browser = await self.p.chromium.launch(args=self.launch_args)
        await self._new_page()

    async def _new_page(self):
        self.ctx = await self.browser.new_context(
            viewport={"width": self.args.width, "height": self.args.height},
            device_scale_factor=self.args.dpr,
            storage_state=self.args.storage_state or None,
        )
        self.page = await self.ctx.new_page()
        self.cdp = await self.ctx.new_cdp_session(self.page)
        await bounded(self.cdp.send("Network.enable"), 10)
        await bounded(self.cdp.send("Network.setCacheDisabled", {"cacheDisabled": True}), 10)
        if PROFILES[self.args.profile]:
            await bounded(self.cdp.send("Network.emulateNetworkConditions",
                                        PROFILES[self.args.profile]), 10)
        if self.args.cpu > 1:
            await bounded(self.cdp.send("Emulation.setCPUThrottlingRate",
                                        {"rate": self.args.cpu}), 10)

    async def restart(self):
        await bounded(self.browser.close(), 20)
        await self.start()

    async def stop(self):
        await bounded(self.browser.close(), 20)

    async def measure(self, url, ready_expr):
        page, args = self.page, self.args
        # 冷缓存：会话级 setCacheDisabled 已在 start() 里打开，这里再清一次缓存与
        # origin 存储，把「新上下文」那部分语义补齐
        if PROFILES[args.profile]:
            await bounded(self.cdp.send("Network.emulateNetworkConditions",
                                        PROFILES[args.profile]), 10)
        await bounded(self.cdp.send("Network.clearBrowserCache"), 10)
        # 清的是「缓存类」存储，**不含 cookies**：登录态是 fixture 的一部分，
        # 不是缓存状态。早先这里写了 "all"，把 session cookie 一起删了，于是
        # /studio 每轮都退化成 /login，永远等不到「能用」（实测两边都 60s 超时）。
        parsed = urllib.parse.urlparse(url)
        await bounded(self.cdp.send("Storage.clearDataForOrigin",
                                    {"origin": f"{parsed.scheme}://{parsed.netloc}",
                                     "storageTypes": "local_storage,indexeddb,cache_storage,service_workers"}), 10)
        await bounded(page.add_init_script(INIT_JS % ready_expr), 10)
        out = {"url": url, "ok": True}
        try:
            await asyncio.wait_for(page.goto(url, wait_until="commit",
                                             timeout=args.timeout * 1000),
                                   timeout=args.timeout + 10)
            await asyncio.wait_for(page.wait_for_selector("html[data-flash-ready]",
                                                          state="attached",
                                                          timeout=args.timeout * 1000),
                                   timeout=args.timeout + 10)
            out["ready_via_dom"] = await bounded(page.get_attribute("html", "data-flash-ready"), 20)
            if args.type_check:
                await bounded(page.click(args.type_check), 20)
                await bounded(page.keyboard.type("Z"), 20)
                typed = await bounded(page.evaluate(
                    "(s) => { const el = document.querySelector(s); if (!el) return false;"
                    " const v = 'value' in el ? el.value : el.innerText; return (v || '').includes('Z'); }",
                    args.type_check), 20)
                out["type_check"] = bool(typed)
                if not typed:
                    out["ok"] = False
            await page.wait_for_timeout(args.settle)
            collected = await bounded(page.evaluate(COLLECT_JS), 30)
            if collected:
                out.update(collected)
            else:
                out["ok"] = False
                out["error"] = "collect 超时"
        except Exception as e:  # 超时或页面出错：如实记录，不计入分位数
            out["ok"] = False
            out["error"] = str(e)[:300]
        return out


def summarize(runs):
    good = [r for r in runs if r.get("ok")]
    s = {"n": len(runs), "n_ok": len(good)}
    for k in ("ready", "lcp", "fcp", "dcl", "load", "longtask", "requests", "bytes_total"):
        vals = [r.get(k) for r in good]
        s[k] = {"p50": pct(vals, 50), "p75": pct(vals, 75), "p95": pct(vals, 95)}
    return s


async def main():
    ap = argparse.ArgumentParser(description="冷缓存下测「打开到能用」")
    ap.add_argument("--url", required=True, help="版本 A 的地址")
    ap.add_argument("--url-b", help="版本 B 的地址；给了就 A、B 交替配对测")
    ap.add_argument("--ready", default="document.readyState !== 'loading' && !!document.body && document.body.innerText.trim().length > 0",
                    help="「能用」的判定 JS 表达式")
    ap.add_argument("--type-check", help="判定为真后往这个选择器打一个字，确认真能输入")
    ap.add_argument("--runs", type=int, default=10)
    ap.add_argument("--profile", choices=list(PROFILES), default="fast4g")
    ap.add_argument("--cpu", type=int, default=1, help="CPU 限速倍数")
    ap.add_argument("--width", type=int, default=1440)
    ap.add_argument("--height", type=int, default=900)
    ap.add_argument("--dpr", type=int, default=1,
                    help="设备像素比。真实用户多在 2/3，srcset 会挑更大的档；"
                         "只测 dpr=1 会看不见 2x 档的体积代价")
    ap.add_argument("--timeout", type=int, default=60, help="单次测量超时秒数")
    ap.add_argument("--settle", type=int, default=500, help="判定为真后再等多少毫秒收集 LCP 等数据")
    ap.add_argument("--proxy", help="访问外网用的代理，如 http://127.0.0.1:7890；本地地址自动直连")
    ap.add_argument("--storage-state", help="Playwright storage state JSON（登录态的 cookie），用于测需要登录的页面")
    ap.add_argument("--out", help="结果 JSON 路径")
    args = ap.parse_args()

    ready_expr = args.ready.replace("%", "%%")

    urls = {"A": args.url}
    if args.url_b:
        urls["B"] = args.url_b
    runs = {k: [] for k in urls}
    started = time.strftime("%Y-%m-%d %H:%M:%S")
    async with async_playwright() as p:
        runner = Runner(p, args)
        await runner.start()
        for i in range(args.runs):
            order = list(urls) if i % 2 == 0 else list(reversed(list(urls)))
            for k in order:
                t_wall = time.time()
                r = await runner.measure(urls[k], ready_expr)
                runs[k].append(r)
                # 一次超时往往意味着网络服务已经卡住，后面每轮都会更糟 —— 换掉整个浏览器
                if not r.get("ok"):
                    await runner.restart()
                flag = "" if r.get("ok") else "  失败: " + r.get("error", "打字校验没通过")
                print(f"[{i + 1}/{args.runs}] {k} ready={r.get('ready') and round(r['ready'])}ms "
                      f"lcp={r.get('lcp') and round(r['lcp'])}ms "
                      f"wall={time.time() - t_wall:.1f}s{flag}", file=sys.stderr)
        await runner.stop()

    result = {
        "started": started, "finished": time.strftime("%Y-%m-%d %H:%M:%S"),
        "config": {k: getattr(args, k) for k in ("runs", "profile", "cpu", "width", "height", "dpr", "ready", "type_check", "storage_state")},
        "paired": bool(args.url_b),
        "results": {k: {"url": urls[k], "summary": summarize(runs[k]), "runs": runs[k]} for k in urls},
    }
    if args.url_b:
        a = result["results"]["A"]["summary"]["ready"]["p75"]
        b = result["results"]["B"]["summary"]["ready"]["p75"]
        if a and b:
            result["ready_p75_reduction"] = round(1 - b / a, 4)

    for k, v in result["results"].items():
        s = v["summary"]
        print(f"{k}  {v['url']}  成功 {s['n_ok']}/{s['n']}  "
              f"能用 p50/p75/p95 = {s['ready']['p50']}/{s['ready']['p75']}/{s['ready']['p95']} ms  "
              f"LCP p75 = {s['lcp']['p75']} ms  请求数 p75 = {s['requests']['p75']}  "
              f"字节 p75 = {s['bytes_total']['p75']}")
    if "ready_p75_reduction" in result:
        print(f"能用 p75 降幅：{result['ready_p75_reduction'] * 100:.1f}%")
    if args.out:
        with open(args.out, "w", encoding="utf-8") as fh:
            json.dump(result, fh, ensure_ascii=False, indent=1)


if __name__ == "__main__":
    asyncio.run(main())
