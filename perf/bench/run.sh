#!/usr/bin/env bash
# 基线 / 每轮优化后的常规测量。口径见 ../基线.md 与 measurement-protocol。
#
#   bash perf/bench/run.sh <base-url> <out-prefix>
#   RUNS=5 bash perf/bench/run.sh http://localhost:8080 perf/bench/base
#
# 落地页是匿名访问，工作台 /studio 未登录会 302 到 /login（数字会假性变好），
# 所以工作台必须带 perf/bench/session.json。
#
# 坑：判定表达式里不要出现反斜杠转义、也不要出现 %（bench.py 用 python 的 % 格式化
# 把它嵌进 INIT_JS，% 会炸）。表达式没成立时 playwright 会反复重试，最后报的却是
# "Content Security Policy" 的 EvalError —— 看到那个报错先怀疑表达式本身没成立。
set -euo pipefail
BASE="${1:-http://localhost:3000}"
OUT="${2:-perf/bench/base}"
RUNS="${RUNS:-10}"
cd "$(dirname "$0")/../.."

LANDING_READY='(() => { const h = document.querySelector(".hero h1"); if (!h || h.offsetParent === null) return false; const imgs = document.querySelectorAll(".compare img"); if (imgs.length < 2) return false; for (const i of imgs) if (!i.complete || i.naturalWidth === 0) return false; return !!document.querySelector(".hero-cta a"); })()'

# "能用" = 输入框在、且 /api/me 已回来（余额已渲染）。少了后半条，一个没水合的
# 空壳也能过 —— 那时点生成没反应，用户等了半天其实是白等。
STUDIO_READY='(() => { const ta = document.querySelector("textarea"); if (!ta || ta.offsetParent === null) return false; const bar = document.querySelector(".costbar"); if (!bar) return false; return !bar.querySelector(".warn"); })()'

python3 perf/bench/mksession.py --base "$BASE" --out perf/bench/session.json >/dev/null 2>&1 || true

echo "== 落地页 / (匿名) =="
python3 perf/bench/bench.py \
  --url "$BASE/" --ready "$LANDING_READY" \
  --runs "$RUNS" --profile fast4g --cpu 1 \
  --out "${OUT}-landing.json"

echo "== 工作台 /studio (已登录) =="
python3 perf/bench/bench.py \
  --url "$BASE/studio" --ready "$STUDIO_READY" --type-check textarea \
  --storage-state perf/bench/session.json \
  --runs "$RUNS" --profile fast4g --cpu 1 \
  --out "${OUT}-studio.json"
