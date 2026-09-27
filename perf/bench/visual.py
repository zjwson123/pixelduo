#!/usr/bin/env python3
"""视觉回归护栏：几何逐像素严格，画面允许图片区域有差异。

    # 采集（两个版本各一次）
    python3 perf/bench/visual.py capture --url http://localhost:8080/ --out perf/shots/base
    python3 perf/bench/visual.py capture --url http://localhost:3000/ --out perf/shots/new
    # 比对
    python3 perf/bench/visual.py diff --a perf/shots/base --b perf/shots/new

分两层判：

1. **几何**（严格，1px）：每个关键元素的 bounding box 与文档总高度。图片换成 webp、
   换成分辨率档，都不该动到任何一格布局。
2. **画面**（宽松，只报告）：图片被重新编码，像素必然有差异。所以比对时会**把图片槽位
   和 marquee 动画区域挖掉**，剩下的区域才是判据 —— 那里应该几乎零差异。
   挖掉的区域单独报一个数字，供人去看编码质量是否可接受（这一条要用户拍板，不是脚本拍板）。
"""
import argparse
import json
import os
import sys

from playwright.async_api import async_playwright

WIDTHS = [(1440, 900), (390, 844)]

GEOMETRY = [
    ".land-nav", ".hero", ".hero h1", ".hero-sub", ".hero-cta", ".hero-meta",
    ".compare", ".strip-sec", ".marquee-mask", ".how", ".how-grid",
    ".land-faq", ".land-pricing", ".price-grid", ".land-cta-band", ".land-footer",
]
# 会被重新编码、因而允许像素差异的区域
IMAGE_SLOTS = [".compare", ".marquee-mask", ".how-cell img"]

READY = ('(() => { const h = document.querySelector(".hero h1"); if (!h || h.offsetParent === null) return false;'
         ' const imgs = document.querySelectorAll(".compare img"); if (imgs.length < 2) return false;'
         ' for (const i of imgs) if (!i.complete || i.naturalWidth === 0) return false;'
         ' return !!document.querySelector(".hero-cta a"); })()')


def _mask_rect(img, rect, scale=1.0):
    from PIL import ImageDraw
    box = [rect["x"] * scale, rect["y"] * scale,
           (rect["x"] + rect["width"]) * scale, (rect["y"] + rect["height"]) * scale]
    ImageDraw.Draw(img).rectangle(box, fill=255)


# 与 bench.py 同款：把「能用」的判定结果写到 DOM 上。这个应用的 CSP 不允许
# eval，playwright 的字符串谓词一遇到「当前还不成立」就会抛 CSP 错误而不是继续等。
INIT = """
(() => {
  const READY = () => { try { return !!(%s); } catch (e) { return false; } };
  const mark = () => {
    if (READY()) { document.documentElement.setAttribute('data-flash-ready','1'); return true; }
    return false;
  };
  const loop = () => { if (!mark()) requestAnimationFrame(loop); };
  requestAnimationFrame(loop);
  setInterval(mark, 100);  // rAF 在负载高的机器上会停摆
})();
"""


async def capture(url: str, out_prefix: str):
    os.makedirs(os.path.dirname(out_prefix) or ".", exist_ok=True)
    manifest = {}
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        for w, h in WIDTHS:
            ctx = await browser.new_context(viewport={"width": w, "height": h}, device_scale_factor=1)
            page = await ctx.new_page()
            errors = []
            page.on("pageerror", lambda e: errors.append(str(e)[:200]))
            await page.add_init_script(INIT.replace("%s", READY))
            await page.goto(url, wait_until="commit")
            await page.wait_for_selector("html[data-flash-ready]", state="attached", timeout=30000)
            await page.wait_for_timeout(700)  # 让动画/字体落定
            geo = await page.evaluate(
                """(sels) => {
                  const r = {};
                  for (const s of sels) {
                    const el = document.querySelector(s);
                    if (!el) { r[s] = null; continue; }
                    const b = el.getBoundingClientRect();
                    r[s] = { x: Math.round(b.x), y: Math.round(b.y + window.scrollY),
                             width: Math.round(b.width), height: Math.round(b.height) };
                  }
                  r["__doc"] = { scrollHeight: document.documentElement.scrollHeight,
                                 scrollWidth: document.documentElement.scrollWidth };
                  return r;
                }""", GEOMETRY)
            masks = await page.evaluate(
                """(sels) => sels.flatMap(s => [...document.querySelectorAll(s)].map(el => {
                     const b = el.getBoundingClientRect();
                     return { x: b.x + window.scrollX, y: b.y + window.scrollY,
                              width: b.width, height: b.height };
                   }))""", IMAGE_SLOTS)
            png = f"{out_prefix}-{w}.png"
            await page.screenshot(path=png, full_page=True, animations="disabled")
            manifest[str(w)] = {"geometry": geo, "masks": masks, "png": png, "pageerrors": errors}
            await ctx.close()
        await browser.close()
    with open(f"{out_prefix}.json", "w", encoding="utf-8") as fh:
        json.dump(manifest, fh, ensure_ascii=False, indent=1)
    print(f"已采集 {out_prefix}.json 与 {out_prefix}-*.png")


def diff(a_prefix: str, b_prefix: str, tolerance_px: int = 1, max_diff_pct: float = 0.05):
    from PIL import Image, ImageChops, ImageDraw
    with open(f"{a_prefix}.json", encoding="utf-8") as fh:
        A = json.load(fh)
    with open(f"{b_prefix}.json", encoding="utf-8") as fh:
        B = json.load(fh)
    bad = 0
    for w in A:
        ga, gb = A[w]["geometry"], B[w]["geometry"]
        for k in ga:
            va, vb = ga[k], gb[k]
            if k == "__doc":
                if va != vb:
                    bad += 1
                    print(f"✗ {w}px 文档尺寸变了: {va} -> {vb}")
                else:
                    print(f"✓ {w}px 文档尺寸 {va}")
                continue
            if va is None or vb is None:
                if va != vb:
                    bad += 1
                    print(f"✗ {w}px {k}: 一个版本里不存在 ({va} vs {vb})")
                continue
            delta = max(abs(va["x"] - vb["x"]), abs(va["y"] - vb["y"]),
                        abs(va["width"] - vb["width"]), abs(va["height"] - vb["height"]))
            if delta > tolerance_px:
                bad += 1
                print(f"✗ {w}px {k} 位移 {delta}px: {va} -> {vb}")
        print(f"✓ {w}px 几何逐项比对完成（{len(ga) - 1} 个元素）")

        ia = Image.open(A[w]["png"]).convert("RGB")
        ib = Image.open(B[w]["png"]).convert("RGB")
        if ia.size != ib.size:
            bad += 1
            print(f"✗ {w}px 全页截图尺寸不同: {ia.size} vs {ib.size}")
            continue
        # 挖掉图片槽位与 marquee 动画：那里像素本来就会变
        mask = Image.new("L", ia.size, 0)
        for rect in B[w]["masks"]:
            _mask_rect(mask, rect)
        d = ImageChops.difference(ia, ib)
        gray = d.convert("L")
        total = ia.size[0] * ia.size[1]
        # 非图片区域
        outside = Image.composite(Image.new("L", ia.size, 0), gray, mask)
        hist = outside.histogram()
        changed_outside = sum(hist[9:])  # 忽略 8/255 以内的重编码噪声
        pct_outside = changed_outside / total * 100
        # 图片区域：只报告
        inside = Image.composite(gray, Image.new("L", ia.size, 0), mask)
        hist_in = inside.histogram()
        changed_inside = sum(hist_in[9:])
        pct_inside = changed_inside / max(total, 1) * 100
        print(f"{'✓' if pct_outside <= max_diff_pct else '✗'} {w}px 图片以外区域差异 {pct_outside:.4f}% "
              f"(阈值 {max_diff_pct}%)")
        print(f"  {w}px 图片区域差异 {pct_inside:.2f}%（重新编码所致，供人工看质量）")
        if pct_outside > max_diff_pct:
            bad += 1
            out = f"{b_prefix}-{w}-diff.png"
            ImageChops.difference(ia, ib).save(out)
            print(f"  差异图已存 {out}")
    if bad:
        print(f"\n✗ 视觉回归失败：{bad} 项")
        sys.exit(1)
    print("\n✓ 视觉回归通过")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("mode", choices=["capture", "diff"])
    ap.add_argument("--url")
    ap.add_argument("--out")
    ap.add_argument("--a")
    ap.add_argument("--b")
    args = ap.parse_args()
    if args.mode == "capture":
        import asyncio
        asyncio.run(capture(args.url, args.out))
    else:
        diff(args.a, args.b)


if __name__ == "__main__":
    main()
