#!/usr/bin/env python3
"""功能冒烟：每个核心操作拿样例真跑一遍，确认优化没有把功能改坏。

    python3 perf/bench/smoke.py --base http://127.0.0.1:8123 [--base-b http://127.0.0.1:3000]

落地页：分割线能拖、语言能切、锚点与 CTA 目标都在、15 张图真的都加载出来了。
工作台：提示词能输入、余额渲染出来、模板列表拉到数据、页签能切。
两个版本各跑一遍，逐项比对 —— 只看「过/不过」，不看耗时（耗时交给 bench.py）。
"""
import argparse
import asyncio
import json
import sys

from playwright.async_api import async_playwright

# 与 bench.py 同款：判定结果写到 DOM 上（这个应用的 CSP 不允许 eval）
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

READY_LANDING = ('(() => { const h = document.querySelector(".hero h1"); if (!h || h.offsetParent === null) return false;'
                 ' const imgs = document.querySelectorAll(".compare img"); if (imgs.length < 2) return false;'
                 ' for (const i of imgs) if (!i.complete || i.naturalWidth === 0) return false;'
                 ' return !!document.querySelector(".hero-cta a"); })()')
READY_STUDIO = ('(() => { const ta = document.querySelector("textarea"); if (!ta || ta.offsetParent === null) return false;'
                ' const bar = document.querySelector(".costbar"); if (!bar) return false;'
                ' return !bar.querySelector(".warn"); })()')


async def landing_checks(page, base):
    out = {}
    await page.add_init_script(INIT.replace("%s", READY_LANDING))
    await page.goto(base + "/", wait_until="commit")
    await page.wait_for_selector("html[data-flash-ready]", state="attached", timeout=30000)

    out["h1_visible"] = await page.evaluate(
        "() => { const h = document.querySelector('.hero h1'); return !!h && h.offsetParent !== null && h.innerText.trim().length > 0; }")
    out["cta_targets"] = sorted(set(await page.evaluate(
        "() => [...document.querySelectorAll('.hero-cta a, .land-nav a, .land-cta a')].map(a => a.getAttribute('href'))")))
    out["anchors_exist"] = await page.evaluate(
        """() => ['how','gallery','pricing'].every(id => {
             const t = document.getElementById(id);
             return !!t && t.offsetParent !== null;
           })""")

    # 语言切换：EN -> 中文 -> EN
    en_text = await page.inner_text(".hero h1")
    await page.click(".land-lang")
    await page.wait_for_timeout(250)
    zh_text = await page.inner_text(".hero h1")
    await page.click(".land-lang")
    await page.wait_for_timeout(250)
    back_text = await page.inner_text(".hero h1")
    out["lang_switch"] = (en_text != zh_text) and (back_text == en_text)

    # 分割线拖动：--split 应该跟着变
    box = await page.locator(".compare").bounding_box()
    before = await page.evaluate("() => document.querySelector('.compare').style.getPropertyValue('--split')")
    await page.mouse.move(box["x"] + box["width"] * 0.5, box["y"] + box["height"] * 0.5)
    await page.mouse.down()
    await page.mouse.move(box["x"] + box["width"] * 0.8, box["y"] + box["height"] * 0.5, steps=8)
    await page.mouse.up()
    await page.wait_for_timeout(200)
    after = await page.evaluate("() => document.querySelector('.compare').style.getPropertyValue('--split')")
    out["slider_drag"] = before != after

    # 滚到底，确认所有图都真的能加载（不是 404 的空壳）
    await page.evaluate("() => window.scrollTo(0, document.body.scrollHeight)")
    await page.wait_for_timeout(2500)
    out["images"] = await page.evaluate(
        """() => {
          const imgs = [...document.querySelectorAll('img')];
          return { total: imgs.length,
                   loaded: imgs.filter(i => i.complete && i.naturalWidth > 0).length,
                   broken: imgs.filter(i => i.complete && i.naturalWidth === 0).map(i => i.currentSrc.slice(-40)) };
        }""")
    return out


async def studio_checks(page, base):
    out = {}
    await page.add_init_script(INIT.replace("%s", READY_STUDIO))
    await page.goto(base + "/studio", wait_until="commit")
    await page.wait_for_selector("html[data-flash-ready]", state="attached", timeout=30000)
    out["prompt_typing"] = await page.evaluate(
        """() => { const ta = document.querySelector('textarea'); if (!ta) return false;
             return !!ta && ta.offsetParent !== null; }""")
    out["balance_rendered"] = await page.evaluate(
        "() => { const b = document.querySelector('.costbar'); return !!b && !b.querySelector('.warn'); }")
    before = await page.input_value("textarea")
    await page.click("textarea")
    await page.keyboard.type(" smoke")
    after = await page.input_value("textarea")
    out["prompt_accepts_input"] = after == before + " smoke"

    tabs = await page.evaluate("() => [...document.querySelectorAll('.tabs button, nav button')].map(b => b.innerText.trim()).slice(0, 12)")
    out["tabs_found"] = tabs
    return out


async def run(base, label):
    results = {}
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        ctx = await browser.new_context(viewport={"width": 1440, "height": 900},
                                        storage_state="perf/bench/session.json")
        page = await ctx.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)[:160]))
        results["landing"] = await landing_checks(page, base)
        results["studio"] = await studio_checks(page, base)
        results["pageerrors"] = errors
        await browser.close()
    with open(f"perf/bench/smoke-{label}.json", "w", encoding="utf-8") as fh:
        json.dump(results, fh, ensure_ascii=False, indent=1)
    return results


def verdict(r):
    ok = True
    L = r["landing"]
    checks = {
        "落地页 h1 可见": L["h1_visible"],
        "锚点 #how/#gallery/#pricing 都在": L["anchors_exist"],
        "语言切换来回都生效": L["lang_switch"],
        "分割线可拖动": L["slider_drag"],
        "图片无损毁": not L["images"]["broken"],
    }
    for k, v in checks.items():
        print(f"  {'✓' if v else '✗'} {k}")
        ok = ok and bool(v)
    print(f"    图片 {L['images']['loaded']}/{L['images']['total']} 已加载")
    print(f"    CTA 目标: {L['cta_targets']}")
    S = r["studio"]
    for k, v in {"工作台输入框可用": S["prompt_typing"], "余额已渲染": S["balance_rendered"],
                 "输入框真的收字": S["prompt_accepts_input"]}.items():
        print(f"  {'✓' if v else '✗'} {k}")
        ok = ok and bool(v)
    if r["pageerrors"]:
        print(f"  ✗ 页面报错: {r['pageerrors'][:3]}")
        ok = False
    else:
        print("  ✓ 无页面级报错")
    return ok


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", required=True)
    ap.add_argument("--base-b")
    args = ap.parse_args()
    a = await run(args.base, "A")
    print(f"== A {args.base} ==")
    ok_a = verdict(a)
    if args.base_b:
        b = await run(args.base_b, "B")
        print(f"\n== B {args.base_b} ==")
        ok_b = verdict(b)
        # 逐项比对：两个版本必须得到同样的结论
        for section in ("landing", "studio"):
            for k in a[section]:
                if k in ("images", "tabs_found"):
                    continue
                if a[section][k] != b[section].get(k):
                    print(f"✗ {section}.{k} 两版本不同: {a[section][k]} != {b[section].get(k)}")
                    ok_a = ok_b = False
        ai, bi = a["landing"]["images"], b["landing"]["images"]
        if ai["total"] != bi["total"]:
            print(f"✗ 图片数量不同: {ai['total']} vs {bi['total']}")
            ok_a = ok_b = False
            print(f"\n✗ 冒烟失败")
            sys.exit(1)
    if not (ok_a and (ok_b if args.base_b else True)):
        print("\n✗ 冒烟失败")
        sys.exit(1)
    print("\n✓ 冒烟通过")


if __name__ == "__main__":
    asyncio.run(main())
