// app.jsx — 原型外壳: Landing / Studio / 设计系统 三视图切换
const { useState } = React;

const COLORS = [
  { c: "#FAFAF8", n: "Paper / 页面底", v: "landing bg" },
  { c: "#FFFFFF", n: "Raised / 卡片", v: "landing surface" },
  { c: "#111112", n: "Ink / 主文字", v: "landing text" },
  { c: "#2E4DEB", n: "Cobalt / 交互色", v: "the one accent" },
  { c: "#0B0B0C", n: "Graphite / 工作台底", v: "studio bg" },
  { c: "#141416", n: "Graphite raised", v: "studio surface" },
  { c: "#F2F2F0", n: "Graphite ink", v: "studio text" },
  { c: "#0E8A5F", n: "Ok / 成功", v: "semantic only" },
];

function System() {
  return (
    <div className="sys" data-screen-label="design-system">
      <h2 style={{ marginTop: 0 }}>Quiet Gallery · 设计 Token</h2>
      <p style={{ color: "var(--ink-2)", maxWidth: "62ch" }}>
        原则：界面是安静的画框，作品是唯一的色彩。全站单一交互色（Cobalt），中性色无暖调，
        排版承担层级，动效只表达状态与反馈。浅色用于对外叙事（落地页），深色用于长时间创作（工作台），
        两页各自锁定主题。
      </p>

      <h2>色彩</h2>
      <div className="swatches">
        {COLORS.map((s) => (
          <div key={s.n} className="sw">
            <div className="c" style={{ background: s.c }}></div>
            <div className="l"><b>{s.n}</b><span>{s.c} · {s.v}</span></div>
          </div>
        ))}
      </div>

      <h2>字体尺度（1.333 完美四度）</h2>
      <div className="type-row"><span className="tag-l">Display 44-84</span><span style={{ fontSize: "clamp(44px,7vw,84px)", fontWeight: 700, letterSpacing: "-.035em", lineHeight: 1 }}>一个提示词，两种回答</span></div>
      <div className="type-row"><span className="tag-l">H1 32-52</span><span style={{ fontSize: "clamp(32px,4.4vw,52px)", fontWeight: 700, letterSpacing: "-.03em" }}>三步，从想法到成片</span></div>
      <div className="type-row"><span className="tag-l">H3 19</span><span style={{ fontSize: 19, fontWeight: 700 }}>写下意图</span></div>
      <div className="type-row"><span className="tag-l">Body 15.5</span><span style={{ fontSize: 15.5 }}>拖动分割线逐像素对比，生成前看清每一分的去向。</span></div>
      <div className="type-row"><span className="tag-l">Micro 11.5</span><span style={{ fontSize: 11.5, letterSpacing: ".14em", textTransform: "uppercase", fontWeight: 700, color: "var(--ink-3)" }}>EYEBROW · 每三节最多一个</span></div>

      <h2>圆角与动效</h2>
      <p style={{ color: "var(--ink-2)", fontSize: 14.5 }}>
        圆角三档封顶：面板 12px · 控件 8px · 按钮 full。动效基准 240ms，曲线 cubic-bezier(.16,1,.3,1)，
        触感反馈 active:scale(.97)，全部动效尊重 prefers-reduced-motion。
      </p>
    </div>
  );
}

function App() {
  const [view, setLocaleView] = useState("landing");
  const [locale, setLocale] = useState("zh");
  // 切换视图时重置滚动（真实产品中不同页面天然重置）
  React.useEffect(() => { window.scrollTo(0, 0); }, [view]);
  const setView = (v) => setLocaleView(v);
  return (
    <>
      {view === "landing" && <Landing locale={locale} setLocale={setLocale} />}
      {view === "studio" && <Studio />}
      {view === "system" && <System />}
      <nav className="proto-bar" aria-label="设计稿视图切换">
        {[["landing", "落地页"], ["studio", "工作台"], ["system", "设计系统"]].map(([id, label]) => (
          <button key={id} className={view === id ? "on" : ""} onClick={() => setView(id)}>{label}</button>
        ))}
      </nav>
    </>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
