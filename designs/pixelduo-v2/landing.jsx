// landing.jsx — Paper Gallery 落地页
const { useState, useRef, useCallback, useEffect } = React;

// 签名交互: 拖动分割线逐像素对比两个模型的输出
function CompareSlider() {
  const ref = useRef(null);
  const [split, setSplit] = useState(50);
  const dragging = useRef(false);

  const move = useCallback((clientX) => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const pct = Math.min(96, Math.max(4, ((clientX - r.left) / r.width) * 100));
    setSplit(pct);
  }, []);

  useEffect(() => {
    const up = () => (dragging.current = false);
    const mv = (e) => dragging.current && move(e.clientX);
    const tv = (e) => dragging.current && move(e.touches[0].clientX);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointermove", mv);
    window.addEventListener("touchmove", tv, { passive: true });
    return () => {
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointermove", mv);
      window.removeEventListener("touchmove", tv);
    };
  }, [move]);

  return (
    <div
      ref={ref}
      className="compare reveal d2"
      style={{ "--split": split + "%" }}
      onPointerDown={(e) => { dragging.current = true; move(e.clientX); }}
      onTouchStart={(e) => { dragging.current = true; move(e.touches[0].clientX); }}
      role="slider" aria-label="拖动对比两个模型的输出" aria-valuenow={Math.round(split)}
    >
      <img src={IMG(1)} alt="GPT Image 输出：城市生命系统图谱" draggable="false" />
      <img className="right-img" src={IMG(225)} alt="Seedream 输出：大师级真迹复刻" draggable="false" />
      <span className="tag tag-l">GPT Image 2</span>
      <span className="tag tag-r">Seedream 5</span>
      <div className="divider"></div>
      <div className="knob"><ArrowLeftRight size={17} /></div>
    </div>
  );
}

function Marquee() {
  const items = [...MARQUEE, ...MARQUEE];
  return (
    <div className="marquee-mask">
      <div className="marquee">
        {items.map((m, i) => (
          <figure key={i} className="mq-item">
            <img src={m.img} alt={m.alt} loading="lazy" />
          </figure>
        ))}
      </div>
    </div>
  );
}

function Landing({ locale, setLocale }) {
  const t = T[locale];
  const zh = locale === "zh";
  return (
    <div className="land" data-screen-label="landing">
      <nav className="land-nav">
        <a className="brand" href="#top">
          <span className="logo-mark"><i></i><i></i></span>
          PixelDuo
        </a>
        <div className="land-nav-links">
          <a href="#how">{t.navHow}</a>
          <a href="#gallery">{t.navModels}</a>
          <a href="#pricing">{t.navPricing}</a>
        </div>
        <div className="land-nav-cta">
          <button className="btn btn-ghost" onClick={() => setLocale(zh ? "en" : "zh")}>{zh ? "EN" : "中文"}</button>
          <a className="btn btn-ghost" href="#top">{t.signIn}</a>
          <a className="btn btn-primary" href="#pricing">{t.start}</a>
        </div>
      </nav>

      <header className="hero" id="top">
        <div className="hero-copy">
          <h1 className="reveal">
            {t.heroTitleA}<br /><em>{t.heroTitleB}{t.heroTitleC}</em>
          </h1>
          <p className="hero-sub reveal d1">{t.heroSub}</p>
          <div className="hero-cta reveal d2">
            <a className="btn btn-primary" href="#pricing">{t.heroCta1}</a>
            <a className="btn btn-ghost" href="#how">{t.heroCta2}</a>
          </div>
          <div className="hero-meta reveal d3">
            <div><b>{t.metaModelsV}</b>{t.metaModels}</div>
            <div><b>{t.metaCostV}</b>{t.metaCost}</div>
            <div><b>{t.metaOwnV}</b>{t.metaOwn}</div>
          </div>
        </div>
        <CompareSlider />
      </header>

      <section className="strip-sec" id="gallery">
        <div className="sec-head">
          <h2 className="reveal">{t.stripTitle}</h2>
        </div>
        <Marquee />
      </section>

      <section className="how" id="how">
        <div className="sec-head" style={{ marginLeft: 0, padding: 0 }}>
          <h2 className="reveal">{t.howTitle}</h2>
        </div>
        <div className="how-grid">
          <div className="how-cell reveal">
            <span className="n">01</span>
            <div>
              <h3>{t.how1t}</h3>
              <p>{t.how1p}</p>
            </div>
            <img src={IMG(17)} alt="提示词助手界面示意" loading="lazy" />
          </div>
          <div className="how-cell reveal d1">
            <span className="n">02</span>
            <div>
              <h3>{t.how2t}</h3>
              <p>{t.how2p}</p>
            </div>
            <img src={IMG(338)} alt="双引擎对比示意" loading="lazy" />
          </div>
          <div className="how-cell reveal d2">
            <span className="n">03</span>
            <div>
              <h3>{t.how3t}</h3>
              <p>{t.how3p}</p>
            </div>
            <img src={IMG(402)} alt="透明账本示意" loading="lazy" />
          </div>
        </div>
      </section>

      <section className="pricing" id="pricing">
        <div className="sec-head" style={{ marginLeft: 0, padding: 0 }}>
          <h2 className="reveal">{t.pricingTitle}</h2>
          <p className="reveal d1">{t.pricingSub}</p>
        </div>
        <div className="price-grid">
          {PLANS.map((p, i) => (
            <div key={p.id} className={"price-card reveal d" + i % 4 + (p.hot ? " hot" : "")}>
              <span className="plan">{p.name}</span>
              <span className="amt">{p.price}<small>{p.per}</small></span>
              <ul>
                {p.feat.map((f) => (
                  <li key={f}><Check size={14} />{f}</li>
                ))}
              </ul>
              <a className={"btn " + (p.hot ? "btn-primary" : "btn-ghost")} href="#top">{p.cta}</a>
            </div>
          ))}
        </div>
      </section>

      <section style={{ maxWidth: 1360, margin: "0 auto", padding: "0 clamp(20px,5vw,56px)" }}>
        <div className="foot-cta reveal">
          <div>
            <h2>{t.ctaTitle}</h2>
            <p>{t.ctaSub}</p>
          </div>
          <a className="btn btn-primary" href="#top" style={{ background: "#fff", color: "#111" }}>{t.start}</a>
        </div>
      </section>

      <footer className="land-foot">{t.footer}</footer>
    </div>
  );
}

Object.assign(window, { Landing });
