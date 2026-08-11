// PixelDuo workbench prototype — App state + screens

const {
  useState, useEffect, useRef,
} = React;

const {
  IconSparkle, IconGrid, IconLibrary, IconCard, IconSun, IconMoon, IconBolt, IconCoins, IconCompare,
} = window;

const {
  Seg, PromptAssistant, CostBar, TemplateCard, GalleryCard, PlanCard, PackButton, CheckoutModal, EmptyState,
} = window;

const { ASSETS, estimateCost, CATEGORIES, TEMPLATES, GALLERY_ITEMS, PLANS, PACKS, STYLE_HINTS } = window;

const TABS = [
  { id: "create", label: "Create", Icon: IconBolt },
  { id: "explore", label: "Explore", Icon: IconGrid },
  { id: "gallery", label: "Gallery", Icon: IconLibrary },
  { id: "pricing", label: "Pricing", Icon: IconCard },
];

const MODEL_OPTIONS = [
  { value: "gpt", label: "GPT Image 2" },
  { value: "seedream", label: "Seedream 5" },
  { value: "both", label: "Both ⇄" },
];

const QUALITY_OPTIONS = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
];

const COUNT_OPTIONS = [
  { value: 1, label: "1" },
  { value: 2, label: "2" },
  { value: 4, label: "4" },
];

const GEN_STEPS = ["Queued", "Drawing with model…", "Polishing details…", "Finalizing…"];

function resultImage(model, quality, index) {
  if (model === "gpt") {
    const pool = quality === "high" ? [ASSETS.gptHigh, ASSETS.typo, ASSETS.portrait] : [ASSETS.gptMedium, ASSETS.gptHigh, ASSETS.gptMedium];
    return pool[index % pool.length];
  }
  const pool = [ASSETS.seed, ASSETS.cyber, ASSETS.icon3d, ASSETS.seed];
  return pool[index % pool.length];
}

function App() {
  const [tab, setTab] = useState("create");
  const [theme, setTheme] = useState("light");
  const [prompt, setPrompt] = useState("a minimalist ceramic coffee mug on a warm beige background");
  const [model, setModel] = useState("gpt");
  const [quality, setQuality] = useState("medium");
  const [count, setCount] = useState(1);
  const [balance, setBalance] = useState(128);
  const [results, setResults] = useState([]);
  const [generating, setGenerating] = useState(false);
  const [genStep, setGenStep] = useState(0);
  const [toast, setToast] = useState("");
  const [cat, setCat] = useState("全部");
  const [checkout, setCheckout] = useState(null);
  const [method, setMethod] = useState("Card");
  const [currentPlan, setCurrentPlan] = useState("free");
  const [spent, setSpent] = useState(0);
  const timerRef = useRef(null);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(""), 2600);
    return () => clearTimeout(t);
  }, [toast]);

  useEffect(() => () => clearInterval(timerRef.current), []);

  const cost = estimateCost(model, quality);
  const totalCost = cost.credits * count;

  const startGenerate = () => {
    if (generating) return;
    if (balance < totalCost) {
      setToast("余额不足，请先充值积分");
      return;
    }
    setGenerating(true);
    setGenStep(0);
    let step = 0;
    clearInterval(timerRef.current);
    timerRef.current = setInterval(() => {
      step += 1;
      if (step >= GEN_STEPS.length) {
        clearInterval(timerRef.current);
        const newItems = Array.from({ length: count }, (_, i) => ({
          id: "r" + Date.now() + i,
          img: resultImage(model === "both" ? (i % 2 === 0 ? "gpt" : "seedream") : model, quality, i),
          model: model === "both" ? (i % 2 === 0 ? "gpt" : "seedream") : model,
          quality: model === "seedream" ? "standard" : quality,
          credits: model === "both" ? Math.ceil(totalCost / count) : totalCost / count,
          prompt: prompt.slice(0, 60),
          time: "just now",
        }));
        setResults((r) => [...newItems, ...r]);
        setBalance((b) => b - totalCost);
        setSpent((s) => s + totalCost);
        setGenerating(false);
        setToast("生成完成 · 消耗 " + totalCost + " credits");
      } else {
        setGenStep(step);
      }
    }, 1500);
  };

  const pickTemplate = (t) => {
    setPrompt(t.prompt);
    setModel(t.model);
    if (t.quality !== "standard") setQuality(t.quality);
    setTab("create");
    setToast("已套用模板，可直接生成");
  };

  const openCheckout = (item, kind) => {
    setCheckout({
      kind,
      name: kind === "pack" ? "Credit pack · " + item.credits : item.name + " plan",
      credits: kind === "pack" ? item.credits : item.credits,
      price: kind === "pack" ? item.price : item.price,
      item,
    });
  };

  const confirmCheckout = (order) => {
    if (order.kind === "pack") {
      setBalance((b) => b + order.item.credits);
      setToast("Beta 模拟到账 " + order.item.credits + " credits");
    } else {
      setCurrentPlan(order.item.id);
      setBalance((b) => b + order.item.credits.split(" ")[0] * 1);
      setToast("已激活 " + order.item.name + "（Beta 模拟）");
    }
    setCheckout(null);
  };

  const filtered = cat === "全部" ? TEMPLATES : TEMPLATES.filter((t) => t.cat === cat);

  return (
    <div>
      <header className="topbar">
        <a className="logo" href="landing.html">
          <span className="logo-mark"><i></i><i></i></span>
          PixelDuo
        </a>
        <nav className="tabs">
          {TABS.map(({ id, label, Icon }) => (
            <button key={id} className={"tab" + (tab === id ? " active" : "")} onClick={() => setTab(id)}>
              <Icon size={15} /><span>{label}</span>
            </button>
          ))}
        </nav>
        <div className="top-right">
          <button className="balance" onClick={() => setTab("pricing")} title="Go to pricing">
            <span className="coin">P</span>
            {balance} <small>credits</small>
          </button>
          <button className="icon-btn" onClick={() => setTheme(theme === "light" ? "dark" : "light")} title="Toggle theme">
            {theme === "light" ? <IconMoon /> : <IconSun />}
          </button>
          <span className="avatar">Z</span>
        </div>
      </header>

      <main className="main">
        {tab === "create" && (
          <>
            <div className="page-head">
              <div>
                <h1>Create</h1>
                <p>One prompt, two engines — see the cost before you generate.</p>
              </div>
              <span className="chip on" style={{ cursor: "default" }}>Beta · invite only</span>
            </div>
            <div className="create-grid">
              <div className="card composer">
                <div>
                  <div className="field-label">Prompt</div>
                  <div className="prompt-box">
                    <textarea
                      value={prompt}
                      onChange={(e) => setPrompt(e.target.value)}
                      placeholder="Describe what you want to create…"
                    />
                    <div className="prompt-meta">
                      <span>{prompt.length} chars</span>
                      <span>EN prompts work best</span>
                    </div>
                  </div>
                  <div className="chips" style={{ marginTop: 8 }}>
                    {STYLE_HINTS.slice(0, 4).map((s) => (
                      <button key={s} className="chip" onClick={() => setPrompt(prompt ? prompt + ", " + s : s)}>{s}</button>
                    ))}
                  </div>
                </div>

                <PromptAssistant prompt={prompt} onApply={(p) => setPrompt(p)} />

                <div>
                  <div className="field-label" style={{ marginBottom: 8 }}>Model</div>
                  <Seg options={MODEL_OPTIONS} value={model} onChange={setModel} tone={model === "gpt" ? "gpt" : model === "seedream" ? "seed" : ""} />
                </div>

                <div className="opt-row">
                  <span className="field-label">Quality</span>
                  {model === "seedream" ? (
                    <span className="chip" style={{ cursor: "default" }}>standard · fixed</span>
                  ) : (
                    <div style={{ width: 230 }}><Seg options={QUALITY_OPTIONS} value={quality} onChange={setQuality} tone="gpt" /></div>
                  )}
                </div>

                <div className="opt-row">
                  <span className="field-label">Count</span>
                  <div style={{ width: 140 }}><Seg options={COUNT_OPTIONS} value={count} onChange={setCount} /></div>
                </div>

                <CostBar cost={{ ...cost, credits: totalCost, usd: cost.usd * count }} balance={balance} />

                <button className={"generate" + (model === "both" ? " both" : "")} disabled={generating} onClick={startGenerate}>
                  {generating ? "Generating…" : model === "both" ? (<><IconCompare size={16} /> Generate both engines</>) : (<><IconSparkle size={16} /> Generate</>)}
                </button>
              </div>

              <div className="card results">
                {generating ? (
                  <>
                    <div className="gen-steps">
                      {GEN_STEPS.map((s, i) => (
                        <div key={s} className={"gen-step" + (i < genStep ? " done" : i === genStep ? " active" : "")}>
                          <span className="dot"></span>{i < genStep ? "✓ " : ""}{s}
                        </div>
                      ))}
                    </div>
                    <div className="results-grid">
                      {Array.from({ length: count }, (_, i) => <div key={i} className="skeleton"></div>)}
                    </div>
                  </>
                ) : results.length === 0 ? (
                  <EmptyState title="Your canvas is empty" sub="Type a prompt, pick an engine, and press Generate — the cost shows up before you commit." />
                ) : (
                  <>
                    <div className="results-head">
                      <h2>Latest results</h2>
                      <span className="count">{results.length} images</span>
                      <span className="spent">session spent {spent} credits</span>
                    </div>
                    <div className="results-grid">
                      {results.map((r) => (
                        <div key={r.id} className="result-card">
                          <img src={r.img} alt={r.prompt} />
                          <div className="result-actions">
                            <button className="result-btn" title="Download (mock)" onClick={() => setToast("Download is a mock in beta")}>↓</button>
                            <button className="result-btn" title="Reuse prompt" onClick={() => setPrompt(r.prompt)}>⤴</button>
                          </div>
                          <div className="result-meta">
                            <span className={"model-pill " + (r.model === "gpt" ? "gpt" : "seed")}><i></i>{r.model === "gpt" ? "GPT" : "Seedream"}</span>
                            <span>{r.quality}</span>
                            <span style={{ marginLeft: "auto" }}>{r.credits} cr</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </div>
            </div>
          </>
        )}

        {tab === "explore" && (
          <>
            <div className="page-head">
              <div>
                <h1>Explore</h1>
                <p>Ready-made prompts with the exact model and parameters attached — one click to reuse.</p>
              </div>
            </div>
            <div className="cat-row">
              {CATEGORIES.map((c) => (
                <button key={c} className={"chip" + (cat === c ? " on" : "")} onClick={() => setCat(c)}>{c}</button>
              ))}
            </div>
            <div className="tmpl-grid">
              {filtered.map((t) => <TemplateCard key={t.id} t={t} onPick={pickTemplate} />)}
            </div>
          </>
        )}

        {tab === "gallery" && (
          <>
            <div className="page-head">
              <div>
                <h1>Gallery</h1>
                <p>Your history — every image keeps its prompt, engine, and exact cost.</p>
              </div>
            </div>
            <div className="gallery-grid">
              {GALLERY_ITEMS.concat(results.map((r) => ({ id: r.id, prompt: r.prompt, model: r.model, credits: r.credits, time: r.time, img: r.img }))).map((g) => (
                <GalleryCard key={g.id} g={g} />
              ))}
            </div>
          </>
        )}

        {tab === "pricing" && (
          <>
            <div className="page-head">
              <div>
                <h1>Plans & credits</h1>
                <p>1 credit = $0.01 · unused monthly quota rolls 30% into next month.</p>
              </div>
              <button className="btn btn-ghost" onClick={() => setTab("create")}>← Back to workbench</button>
            </div>
            <div className="card" style={{ padding: 18, marginBottom: 18, display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
              <span className="coin" style={{ width: 34, height: 34, fontSize: 15 }}>P</span>
              <div>
                <div style={{ fontWeight: 800, fontSize: 18 }}>{balance} credits</div>
                <div style={{ fontSize: 12.5, color: "var(--ink-2)" }}>Free plan · daily check-in +2</div>
              </div>
              <span style={{ marginLeft: "auto", fontSize: 12.5, color: "var(--ink-3)" }}>Beta 壳子 · 不产生真实扣款</span>
            </div>
            <div className="pricing-grid">
              {PLANS.map((p) => <PlanCard key={p.id} plan={p} current={currentPlan} onSelect={(pl) => openCheckout(pl, "plan")} />)}
            </div>
            <div className="field-label" style={{ marginBottom: 10 }}>Top-up packs · valid 12 months</div>
            <div className="pack-row">
              {PACKS.map((p) => <PackButton key={p.id} pack={p} onSelect={(pk) => openCheckout(pk, "pack")} />)}
            </div>
          </>
        )}
      </main>

      {checkout && (
        <CheckoutModal order={checkout} method={method} setMethod={setMethod} onClose={() => setCheckout(null)} onConfirm={confirmCheckout} />
      )}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

const root = ReactDOM.createRoot(document.getElementById("root"));
root.render(<App />);
