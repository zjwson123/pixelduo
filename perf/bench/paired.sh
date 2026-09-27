#!/usr/bin/env bash
# 配对测量：基线（A）与优化版（B）同时起服务，A、B 交替跑，同一时段。
#
#   bash perf/bench/paired.sh http://localhost:8123 http://localhost:3000 <out-prefix>
#
# 分开时段测出来的前后差，有一部分是机器负载差 —— 所以结论一律用这里的数。
set -euo pipefail
A="${1:?基线地址}"
B="${2:?优化版地址}"
OUT="${3:-perf/bench/paired}"
RUNS="${RUNS:-12}"
cd "$(dirname "$0")/../.."

LANDING_READY='(() => { const h = document.querySelector(".hero h1"); if (!h || h.offsetParent === null) return false; const imgs = document.querySelectorAll(".compare img"); if (imgs.length < 2) return false; for (const i of imgs) if (!i.complete || i.naturalWidth === 0) return false; return !!document.querySelector(".hero-cta a"); })()'
STUDIO_READY='(() => { const ta = document.querySelector("textarea"); if (!ta || ta.offsetParent === null) return false; const bar = document.querySelector(".costbar"); if (!bar) return false; return !bar.querySelector(".warn"); })()'

for dpr in 1 2; do
  echo "== 落地页 / (匿名, dpr=$dpr) =="
  python3 perf/bench/bench.py --url "$A/" --url-b "$B/" --ready "$LANDING_READY" \
    --runs "$RUNS" --profile fast4g --dpr "$dpr" --out "${OUT}-landing-dpr${dpr}.json"
done

echo "== 工作台 /studio (已登录, dpr=1) =="
python3 perf/bench/mksession.py --base "$B" --out perf/bench/session.json >/dev/null 2>&1 || true
python3 perf/bench/bench.py --url "$A/studio" --url-b "$B/studio" --ready "$STUDIO_READY" --type-check textarea \
  --storage-state perf/bench/session.json \
  --runs "$RUNS" --profile fast4g --dpr 1 --out "${OUT}-studio-dpr1.json"
