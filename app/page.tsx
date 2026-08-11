import Link from "next/link";

export default function LandingPage() {
  return (
    <div className="landing">
      <header className="nav">
        <div className="nav-inner">
          <Link className="logo" href="/">
            <span className="logo-mark"><i></i><i></i></span>
            PixelDuo
          </Link>
          <nav className="nav-links">
            <a href="#models">Models</a>
            <a href="#features">Features</a>
            <a href="#pricing">Pricing</a>
          </nav>
          <div className="nav-cta">
            <Link className="btn btn-ghost" href="/login">Sign in</Link>
            <Link className="btn btn-dark" href="/register" style={{ marginLeft: 10 }}>Join the beta</Link>
          </div>
        </div>
      </header>

      <main>
        <section>
          <div className="wrap hero-grid">
            <div>
              <span className="eyebrow"><i></i>Dual-engine AI image studio · Beta</span>
              <h1 className="serif">Two models.<br />One prompt. <em>Your call.</em></h1>
              <p className="hero-sub">
                PixelDuo runs GPT Image 2 and Seedream 5 side by side — compare in one click, and see exactly what
                each image costs before you press generate.
              </p>
              <div className="hero-cta">
                <Link className="btn btn-dark" href="/register">Start creating — free</Link>
                <a className="btn btn-ghost" href="#models">See the models</a>
              </div>
              <div className="hero-trust">
                <span>✅ <b>Free beta</b>, invite only</span>
                <span>💡 <b>Transparent</b> per-image cost</span>
                <span>🧠 <b>AI prompt assistant</b> included</span>
              </div>
            </div>
            <div>
              <div className="compare-card">
                <div className="compare-imgs">
                  <figure className="compare-item">
                    <span className="model-tag tag-gpt"><i></i>GPT Image 2</span>
                    <img src="/templates/gpt_medium_1024.png" alt="GPT Image 2 output" />
                  </figure>
                  <figure className="compare-item">
                    <span className="model-tag tag-seed"><i></i>Seedream 5</span>
                    <img src="/templates/seedream_1920.png" alt="Seedream 5 output" />
                  </figure>
                </div>
                <div className="vs">vs</div>
                <div className="compare-specs">
                  <div className="spec">Latency<b>35s · medium</b></div>
                  <div className="spec">Latency<b>15s · 1920²</b></div>
                  <div className="spec">Cost / image<b>$0.053</b></div>
                  <div className="spec">Cost / image<b>¥0.30</b></div>
                </div>
                <p className="compare-note"><b>Same prompt.</b> Two engines. Choose by quality, speed, or price — you see it all up front.</p>
              </div>
            </div>
          </div>
        </section>

        <section id="models">
          <div className="wrap">
            <div className="sec-head">
              <div className="sec-kicker">The power of two</div>
              <h2 className="serif">One studio, two world-class engines.</h2>
              <p>Head-to-head quality without the lock-in. GPT Image 2 for fine details and typography, Seedream 5 for speed and big canvases.</p>
            </div>
            <div className="models-grid">
              <div className="model-card">
                <h3 style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span className="model-dot" style={{ width: 12, height: 12, borderRadius: 4, background: "var(--indigo)" }}></span>
                  GPT Image 2
                </h3>
                <p className="model-desc">The finishing studio — text rendering, fine detail, and consistent quality for final assets.</p>
                <div className="model-stats">
                  <span className="stat-chip">Medium 1024²<b>$0.053 / img</b></span>
                  <span className="stat-chip">High 1024²<b>$0.211 / img</b></span>
                  <span className="stat-chip">Latency<b>35 – 148s</b></span>
                </div>
                <ul className="model-list">
                  <li>Typography and non-Latin text that actually renders</li>
                  <li>Flexible sizes and multi-round editing</li>
                  <li>No platform watermark</li>
                </ul>
              </div>
              <div className="model-card">
                <h3 style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span className="model-dot" style={{ width: 12, height: 12, borderRadius: 4, background: "var(--orange)" }}></span>
                  Seedream 5
                </h3>
                <p className="model-desc">The fast lane — big canvases in seconds, ideal for drafts, batches, and exploration.</p>
                <div className="model-stats">
                  <span className="stat-chip">1920²<b>≈ $0.035 / img</b></span>
                  <span className="stat-chip">Up to 3K<b>3072 × 3072</b></span>
                  <span className="stat-chip">Latency<b>≈ 15s</b></span>
                </div>
                <ul className="model-list">
                  <li>Native 2K / 3K output for print and big screens</li>
                  <li>Reference-image support</li>
                  <li>AI-generated label included (transparent compliance)</li>
                </ul>
              </div>
            </div>
            <div className="duo-banner">
              <div>
                <h4>Not sure which engine? Generate both.</h4>
                <p>One prompt, two outputs, side by side — you pick the winner. Both images are charged separately and clearly.</p>
              </div>
              <Link className="btn btn-dark" href="/register" style={{ marginLeft: "auto" }}>Try the compare</Link>
            </div>
          </div>
        </section>

        <section id="features" style={{ background: "var(--surface)", borderTop: "1px solid var(--line)", borderBottom: "1px solid var(--line)" }}>
          <div className="wrap">
            <div className="sec-head">
              <div className="sec-kicker">Built around trust</div>
              <h2 className="serif">No black boxes. No surprise bills.</h2>
              <p>Every charge is visible before it happens, every model is priced by its real cost, and the AI helps you write better prompts for free.</p>
            </div>
            <div className="feat-grid">
              <div className="feat-card">
                <h3>Transparent cost preview</h3>
                <p>See exactly how many credits — and dollars — an image will use before you generate. Adjust model, quality, or size to match your budget.</p>
              </div>
              <div className="feat-card">
                <h3>AI prompt assistant</h3>
                <p>Type a half-formed thought and get a production-ready prompt — expanded, translated, and styled. Powered by DeepSeek, free on every plan.</p>
              </div>
              <div className="feat-card">
                <h3>Template library</h3>
                <p>E-commerce, portraits, posters, 3D icons — ready-made prompts with the exact model and parameters attached. One click to reuse.</p>
              </div>
              <div className="feat-card">
                <h3>Credits + subscription, your way</h3>
                <p>Credit packs valid for 12 months, and monthly quotas that roll 30% of what you don't use into next month. Plans from free to studio.</p>
              </div>
            </div>
          </div>
        </section>

        <section className="pricing-band" id="pricing">
          <div className="wrap">
            <div className="sec-head">
              <div className="sec-kicker">Fair pricing, no black box · 明码标价</div>
              <h2 className="serif">Plans that respect your wallet.</h2>
              <p>1 credit = $0.01. Rollover 30% of unused monthly credits. Beta is free while we polish.</p>
            </div>
            <div className="plan-grid">
              <div className="plan">
                <h3>Free</h3>
                <div className="price">$0<small> / month</small></div>
                <ul>
                  <li>30 credits on signup</li>
                  <li>2 credits daily check-in</li>
                  <li>Watermarked previews</li>
                </ul>
                <Link className="btn btn-ghost" href="/register">Start free</Link>
              </div>
              <div className="plan">
                <h3>Starter</h3>
                <div className="price">$9<small> / month</small></div>
                <ul>
                  <li>800 credits / month</li>
                  <li>≈ 100–130 images</li>
                  <li>No platform watermark</li>
                </ul>
                <Link className="btn btn-ghost" href="/register">Coming at launch</Link>
              </div>
              <div className="plan featured">
                <span className="badge">Most popular</span>
                <h3>Pro</h3>
                <div className="price">$19<small> / month</small></div>
                <ul>
                  <li>2,000 credits / month</li>
                  <li>≈ 250–330 images</li>
                  <li>30% quota rollover</li>
                </ul>
                <Link className="btn btn-dark" href="/register">Coming at launch</Link>
              </div>
              <div className="plan">
                <h3>Studio</h3>
                <div className="price">$39<small> / month</small></div>
                <ul>
                  <li>5,000 credits / month</li>
                  <li>Team & privacy mode</li>
                  <li>API trial quota</li>
                </ul>
                <Link className="btn btn-ghost" href="/register">Coming at launch</Link>
              </div>
            </div>
          </div>
        </section>

        <section className="cta-band">
          <div className="wrap">
            <h2 className="serif">Ready to see what you can make?</h2>
            <p>Beta is free. Create an account and start generating in minutes.</p>
            <Link className="btn btn-dark" href="/register">Open the workbench →</Link>
          </div>
        </section>
      </main>

      <footer>
        <div className="wrap foot-inner">
          <span className="logo"><span className="logo-mark"><i></i><i></i></span> PixelDuo</span>
          <span className="muted">pixelduo.ai · Two models. One prompt. Your call.</span>
          <span className="muted">
            <Link className="link" href="/terms" style={{ marginRight: 14 }}>Terms</Link>
            <Link className="link" href="/privacy">Privacy</Link>
          </span>
          <span className="muted" style={{ marginLeft: "auto" }}>© 2026 PixelDuo. Beta product — details may change.</span>
        </div>
      </footer>
    </div>
  );
}
