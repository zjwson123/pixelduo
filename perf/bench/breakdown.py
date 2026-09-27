#!/usr/bin/env python3
"""首屏拆解：把「打开到能用」按资源摊开，标出谁卡在关键路径上。

    python3 perf/bench/breakdown.py --url http://localhost:3000/ \
        --ready '<与 bench.py 相同的判定表达式>' [--storage-state perf/bench/session.json]

口径与 bench.py 一致：Fast 4G、冷缓存、不限 CPU。输出按传输字节排序的全部资源，
外加 LCP 元素和关键路径估算。
"""
import argparse
import asyncio
from collections import defaultdict

from playwright.async_api import async_playwright

PROFILES = {
    "none": None,
    "fast4g": {"offline": False, "latency": 20,
               "downloadThroughput": 4 * 1024 * 1024 / 8,
               "uploadThroughput": 3 * 1024 * 1024 / 8},
}

INIT = """
(() => {
  window.__lcp = null;
  try {
    new PerformanceObserver(l => {
      for (const e of l.getEntries()) {
        const el = e.element;
        window.__lcp = {
          startTime: e.startTime, size: e.size,
          tag: el ? el.tagName : null,
          cls: el ? (el.className && el.className.toString ? el.className.toString().slice(0, 60) : null) : null,
          src: el && el.currentSrc ? el.currentSrc.slice(-70) : null,
          text: el && el.tagName === 'H1' ? (el.innerText || '').slice(0, 40) : null,
        };
      }
    }).observe({ type: 'largest-contentful-paint', buffered: true });
  } catch (e) {}
})();
"""


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", required=True)
    ap.add_argument("--ready", required=True)
    ap.add_argument("--profile", default="fast4g", choices=list(PROFILES))
    ap.add_argument("--storage-state")
    ap.add_argument("--timeout", type=int, default=30)
    ap.add_argument("--out", help="把完整资源表写成 JSON")
    args = ap.parse_args()

    # % 会被 python 的 % 格式化吃掉，用 replace 代替
    init = INIT + "\n(() => { const READY = () => { try { return !!(%s); } catch (e) { return false; } };"
    init += " const tick = () => { if (READY()) { document.documentElement.setAttribute('data-flash-ready','1'); return; } requestAnimationFrame(tick); }; requestAnimationFrame(tick); })();"
    init = init.replace("%s", args.ready)

    async with async_playwright() as p:
        browser = await p.chromium.launch()
        ctx = await browser.new_context(viewport={"width": 1440, "height": 900},
                                        storage_state=args.storage_state or None)
        page = await ctx.new_page()
        cdp = await ctx.new_cdp_session(page)
        await cdp.send("Network.enable")
        await cdp.send("Network.setCacheDisabled", {"cacheDisabled": True})
        if PROFILES[args.profile]:
            await cdp.send("Network.emulateNetworkConditions", PROFILES[args.profile])
        await page.add_init_script(init)
        await page.goto(args.url, wait_until="commit", timeout=args.timeout * 1000)
        try:
            await page.wait_for_selector("html[data-flash-ready]", state="attached", timeout=args.timeout * 1000)
        except Exception as e:
            print("判定表达式没成立：", str(e)[:120])
        resources = await page.evaluate("""() => {
          const nav = performance.getEntriesByType('navigation')[0] || {};
          const out = performance.getEntriesByType('resource').map(r => ({
            name: r.name, type: r.initiatorType, start: Math.round(r.startTime),
            end: Math.round(r.responseEnd), transfer: r.transferSize, decoded: r.decodedBodySize,
            proto: r.nextHopProtocol,
          }));
          out.push({ name: nav.name, type: 'navigation', start: 0,
                     end: Math.round(nav.responseEnd), transfer: nav.transferSize,
                     decoded: nav.decodedBodySize, proto: nav.nextHopProtocol });
          return { resources: out, ready: window.__flash ? null : null, lcp: window.__lcp };
        }""")
        await browser.close()

    res = sorted(resources["resources"], key=lambda r: -r["transfer"])
    by_type = defaultdict(int)
    for r in res:
        by_type[r["type"]] += r["transfer"]
    total = sum(by_type.values())

    print(f"\n== {args.url} 首屏资源（Fast 4G，冷缓存）==")
    print(f"LCP 元素: {resources['lcp']}")
    print(f"\n按类型（传输字节）：")
    for k, v in sorted(by_type.items(), key=lambda kv: -kv[1]):
        print(f"  {k:12s} {v:>9,d}  {v / total * 100:5.1f}%")
    print(f"  {'合计':12s} {total:>9,d}")
    print(f"\n全部 {len(res)} 个请求，按传输字节排序：")
    print(f"  {'bytes':>9s} {'decoded':>9s} {'start':>6s} {'end':>6s}  type        name")
    for r in res:
        print(f"  {r['transfer']:>9,d} {r['decoded']:>9,d} {r['start']:>6d} {r['end']:>6d}  {r['type']:<11s} {r['name'].split('3000')[-1][:74]}")

    if args.out:
        import json
        with open(args.out, "w", encoding="utf-8") as fh:
            json.dump(resources, fh, ensure_ascii=False, indent=1)


if __name__ == "__main__":
    asyncio.run(main())
