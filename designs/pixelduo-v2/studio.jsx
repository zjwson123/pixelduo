// studio.jsx — Graphite 工作台 (暗色画廊)
const { useState } = React;

const RESULTS = [
  { img: IMG(390), model: "Seedream 5", credits: 6 },
  { img: IMG(383), model: "GPT Image 2", credits: 26 },
  { img: IMG(396), model: "Seedream 5", credits: 6 },
  { img: IMG(166), model: "GPT Image 2", credits: 26 },
  { img: IMG(355), model: "Seedream 5", credits: 6 },
  { img: IMG(330), model: "GPT Image 2", credits: 26 },
];

const STYLES = ["soft studio lighting", "editorial, magazine", "cyberpunk, neon", "minimal, warm"];

function Studio() {
  const [tab, setTab] = useState("create");
  const [model, setModel] = useState("gpt");
  const [style, setStyle] = useState(null);
  const [prompt, setPrompt] = useState("a golden retriever running through a sunlit wheat field, cinematic wide shot");
  const [gen, setGen] = useState(false);

  const cost = model === "gpt" ? 8 : 6;
  const submit = () => {
    if (gen) return;
    setGen(true);
    setTimeout(() => setGen(false), 5000);
  };

  return (
    <div className="studio" data-screen-label="studio">
      <nav className="st-nav">
        <span className="brand">
          <span className="logo-mark"><i></i><i></i></span>
          PixelDuo
        </span>
        <div className="st-tabs">
          {["create", "edit", "video", "explore", "gallery"].map((id) => (
            <button key={id} className={tab === id ? "on" : ""} onClick={() => setTab(id)}>
              {{ create: "创作", edit: "编辑", video: "视频", explore: "灵感库", gallery: "画廊" }[id]}
            </button>
          ))}
        </div>
        <div className="st-nav-right">
          <span className="credit-pill"><Coin size={14} /> 1,082</span>
          <button className="btn btn-primary" style={{ height: 32, padding: "0 14px", fontSize: 12.5 }}>充值</button>
        </div>
      </nav>

      <div className="st-main">
        <aside className="st-panel">
          <div className="st-field">
            <label>提示词</label>
            <textarea
              className="st-textarea"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="描述你想要的画面…"
            />
          </div>

          <div className="st-field">
            <label>风格灵感</label>
            <div className="st-chips">
              {STYLES.map((s) => (
                <button key={s} className={"st-chip" + (style === s ? " on" : "")}
                        onClick={() => setStyle(style === s ? null : s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>

          <div className="st-field">
            <label>模型</label>
            <div className="seg">
              <button className={model === "gpt" ? "on" : ""} onClick={() => setModel("gpt")}>GPT Image 2</button>
              <button className={model === "seedream" ? "on" : ""} onClick={() => setModel("seedream")}>Seedream 5</button>
            </div>
          </div>

          <div className="st-field">
            <label>质量</label>
            <div className="seg">
              {["low", "medium", "high"].map((q) => (
                <button key={q} className={q === "medium" ? "on" : ""}>{q}</button>
              ))}
            </div>
          </div>

          <div className="st-field">
            <label>数量</label>
            <div className="seg">
              {[1, 2, 4].map((n) => (
                <button key={n} className={n === 1 ? "on" : ""}>{n}</button>
              ))}
            </div>
          </div>

          <button className="st-generate" onClick={submit} disabled={gen}>
            {gen ? <><span className="shimmer" style={{ width: 18, height: 18, borderWidth: 2 }} /> 生成中…</> : <><Sparkle size={16} /> 生成</>}
          </button>
          <div className="cost-line">
            <span>本次消耗 <b>{cost} credits</b> ≈ ${(cost / 100).toFixed(2)}</span>
            <span>余额 1,082</span>
          </div>
        </aside>

        <main className="st-results">
          <div className="st-results-head">
            <h2>{gen ? "正在生成 · 两个引擎已就位" : "最新结果"}</h2>
            <span>共 {RESULTS.length} 项 · 本次会话</span>
          </div>
          <div className="masonry">
            {gen && (
              <div className="gen-card">
                <span className="shimmer"></span>
                <p>同一提示词正在两个引擎上竞技</p>
                <small>已预扣 {cost * 2} credits · 失败自动退款</small>
              </div>
            )}
            {RESULTS.map((r, i) => (
              <figure key={i} className="mas-item">
                <img src={r.img} alt={r.model + " 输出"} loading="lazy" />
                <figcaption className="mas-meta">
                  <span className="pm">{r.model}</span>
                  <span className="cr">{r.credits} credits</span>
                </figcaption>
              </figure>
            ))}
          </div>
        </main>
      </div>
    </div>
  );
}

Object.assign(window, { Studio });
