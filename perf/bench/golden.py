#!/usr/bin/env python3
"""SEO 与内容黄金测试：逐项比对两个版本对外可见的东西。

    python3 perf/bench/golden.py capture --url http://localhost:3000/ --out perf/bench/golden-landing-base.json
    python3 perf/bench/golden.py diff --a perf/bench/golden-landing-base.json --b perf/bench/golden-landing-new.json

有意**不**比对的东西：RSC 载荷（`self.__next_f.push`）里序列化的 props。
图片换成 webp 之后 srcset 必然出现在那里面，把它算进来会让这个测试永远红。
这里只比对用户和爬虫真正看到的部分：title / meta / OpenGraph / twitter / robots /
可见文本 / 标题层级 / 链接目标。
"""
import argparse
import html
import json
import re
import sys
import urllib.request

TEXT_FIELDS = {
    "title": r"<title[^>]*>(.*?)</title>",
    "description": r'<meta name="description" content="([^"]*)"',
    "og:title": r'<meta property="og:title" content="([^"]*)"',
    "og:description": r'<meta property="og:description" content="([^"]*)"',
    "og:url": r'<meta property="og:url" content="([^"]*)"',
    "og:image": r'<meta property="og:image" content="([^"]*)"',
    "og:type": r'<meta property="og:type" content="([^"]*)"',
    "twitter:card": r'<meta name="twitter:card" content="([^"]*)"',
    "twitter:title": r'<meta name="twitter:title" content="([^"]*)"',
    "robots": r'<meta name="robots" content="([^"]*)"',
    "html:lang": r'<html[^>]*lang="([^"]*)"',
    "canonical": r'<link rel="canonical" href="([^"]*)"',
}


def visible_text(doc: str) -> list:
    body = re.sub(r"(?is)<script.*?</script>", " ", doc)
    body = re.sub(r"(?is)<style.*?</style>", " ", body)
    body = re.sub(r"(?is)<head.*?</head>", " ", body)
    body = re.sub(r"(?s)<[^>]+>", "\n", body)
    lines = [html.unescape(x).strip() for x in body.split("\n")]
    return [x for x in lines if x]


def capture(url: str) -> dict:
    with urllib.request.urlopen(url, timeout=30) as r:
        doc = r.read().decode("utf-8", "replace")
    out = {k: (re.search(p, doc, re.S).group(1) if re.search(p, doc, re.S) else None)
           for k, p in TEXT_FIELDS.items()}
    out["headings"] = [html.unescape(re.sub(r"<[^>]+>", "", h)).strip()
                       for h in re.findall(r"(?is)<h[1-3][^>]*>(.*?)</h[1-3]>", doc)]
    out["links"] = re.findall(r'<a[^>]*href="([^"]*)"', doc)
    out["text"] = visible_text(doc)
    out["imgs_alt"] = re.findall(r"<img[^>]*alt=\"([^\"]*)\"", doc)
    return out


def diff(a: dict, b: dict) -> int:
    bad = 0
    for k in sorted(set(a) | set(b)):
        if k == "text":
            ta, tb = a.get(k, []), b.get(k, [])
            if ta != tb:
                bad += 1
                print(f"✗ 可见文本不一致：{len(ta)} 行 vs {len(tb)} 行")
                for i, (x, y) in enumerate(zip(ta, tb)):
                    if x != y:
                        print(f"    第 {i} 行: {x!r} != {y!r}")
                if len(ta) != len(tb):
                    only_a = [x for x in ta if x not in tb][:5]
                    only_b = [x for x in tb if x not in ta][:5]
                    print(f"    只在 A: {only_a}\n    只在 B: {only_b}")
            else:
                print(f"✓ 可见文本一致（{len(ta)} 行）")
        else:
            va, vb = a.get(k), b.get(k)
            if va != vb:
                bad += 1
                print(f"✗ {k}:\n    A={va!r}\n    B={vb!r}")
            else:
                print(f"✓ {k} = {va!r}")
    return bad


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("mode", choices=["capture", "diff"])
    ap.add_argument("--url")
    ap.add_argument("--out")
    ap.add_argument("--a")
    ap.add_argument("--b")
    args = ap.parse_args()

    if args.mode == "capture":
        data = capture(args.url)
        with open(args.out, "w", encoding="utf-8") as fh:
            json.dump(data, fh, ensure_ascii=False, indent=1)
        print(f"已写入 {args.out}：{len(data['text'])} 行文本、{len(data['links'])} 个链接、{len(data['imgs_alt'])} 个 alt")
        return
    with open(args.a, encoding="utf-8") as fh:
        a = json.load(fh)
    with open(args.b, encoding="utf-8") as fh:
        b = json.load(fh)
    bad = diff(a, b)
    if bad:
        print(f"\n✗ {bad} 项不一致")
        sys.exit(1)
    print("\n✓ 全部一致")


if __name__ == "__main__":
    main()
