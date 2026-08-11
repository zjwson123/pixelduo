// Presentational components (shared via window)

const { IconWand, IconSparkle, IconArrow, IconCheck, IconX } = window;

function ModelBadge({ model }) {
  const cls = model === "gpt" ? "gpt" : "seed";
  const label = model === "gpt" ? "GPT Image 2" : "Seedream 5";
  return (
    <span className={"model-pill " + cls}>
      <i></i>{label}
    </span>
  );
}

function Seg({ options, value, onChange, tone }) {
  return (
    <div className="seg" role="tablist">
      {options.map((o) => (
        <button
          key={o.value}
          className={(value === o.value ? "on" : "") + (tone && value === o.value ? " " + tone : "")}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function PromptAssistant({ prompt, onApply }) {
  const [output, setOutput] = React.useState("");
  const [sugs, setSugs] = React.useState(["soft studio lighting, high detail", "editorial, magazine quality", "cyberpunk, neon accents"]);

  const run = (fn) => {
    const out = fn(prompt);
    setOutput(out);
  };

  return (
    <div className="assistant">
      <div className="assistant-head">
        <span className="spark"><IconSparkle /></span>
        Prompt assistant · DeepSeek
        <span style={{ marginLeft: "auto", fontWeight: 500, color: "var(--ink-3)" }}>free</span>
      </div>
      <div className="assistant-body">
        <div className="assist-actions">
          {window.SUGGESTIONS.map((s) => (
            <button key={s.label} className="mini-btn" onClick={() => run(s.fn)}>
              <IconWand size={13} /> {s.label}
            </button>
          ))}
        </div>
        {output && (
          <div className="assistant-output">
            {output}
            <button className="mini-btn" style={{ marginTop: 8 }} onClick={() => { onApply(output); setOutput(""); }}>
              <IconCheck size={12} /> 使用这条 prompt
            </button>
          </div>
        )}
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {sugs.map((s) => (
            <button key={s} className="suggestion" onClick={() => onApply(prompt ? prompt + ", " + s : s)}>
              <IconArrow size={12} style={{ marginRight: 6 }} />{s}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function CostBar({ cost, balance }) {
  const ok = balance >= cost.credits;
  return (
    <div className="costbar">
      <span>
        {cost.label} · 本次消耗
        <span className="amount"> {cost.credits} <small>credits ≈ ${cost.usd.toFixed(2)}</small></span>
      </span>
      {ok ? (
        <span style={{ color: "var(--ink-2)" }}>余额 {balance}</span>
      ) : (
        <span className="warn">余额不足 · 去充值</span>
      )}
    </div>
  );
}

function TemplateCard({ t, onPick }) {
  return (
    <div className="card tmpl-card" onClick={() => onPick(t)}>
      <img src={t.img} alt={t.title} />
      <div className="tmpl-body">
        <h3>{t.title}</h3>
        <p>{t.prompt}</p>
        <div className="tmpl-foot">
          <ModelBadge model={t.model} />
          <span>{t.credits} credits</span>
          <span className="spacer"></span>
          <span style={{ color: "var(--indigo)", fontWeight: 700 }}>一键复用 →</span>
        </div>
      </div>
    </div>
  );
}

function GalleryCard({ g }) {
  return (
    <div className="card gal-card">
      <img src={g.img} alt={g.prompt} />
      <div className="gal-body">
        <div className="prompt">{g.prompt}</div>
        <div className="gal-meta">
          <ModelBadge model={g.model} />
          <span>{g.credits} cr</span>
          <span className="spacer"></span>
          <span>{g.time}</span>
        </div>
      </div>
    </div>
  );
}

function PlanCard({ plan, onSelect, current }) {
  return (
    <div className={"card plan-card" + (plan.featured ? " featured" : "")}>
      <h3>{plan.name}</h3>
      <div className="price">${plan.price}<small> / month</small></div>
      <div style={{ fontSize: 12.5, color: "var(--ink-2)" }}>{plan.credits}</div>
      <ul>
        {plan.features.map((f) => <li key={f}>{f}</li>)}
      </ul>
      <button className={plan.featured ? "btn btn-dark" : "btn btn-ghost"} onClick={() => onSelect(plan)}>
        {current === plan.id ? "当前计划" : plan.price === 0 ? "当前计划" : "选择"}
      </button>
    </div>
  );
}

function PackButton({ pack, onSelect }) {
  return (
    <button className="pack" onClick={() => onSelect(pack)}>
      <span className="price">${pack.price}</span>
      <span className="credits">{pack.credits} credits</span>
      {pack.bonus && <span className="bonus">{pack.bonus} bonus</span>}
    </button>
  );
}

function CheckoutModal({ order, onClose, onConfirm, method, setMethod }) {
  const methods = ["Card", "PayPal", "Alipay", "WeChat Pay"];
  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>Checkout · 结账壳子</h2>
          <button className="icon-btn" onClick={onClose}><IconX /></button>
        </div>
        <div className="modal-body">
          <div className="order-row"><span className="lbl">Item</span><span className="val">{order.name}</span></div>
          <div className="order-row"><span className="lbl">Credits</span><span className="val">{order.credits}</span></div>
          <div className="order-row order-total"><span className="lbl">Total</span><span className="val">${order.price.toFixed(2)}</span></div>
          <div>
            <div className="field-label" style={{ marginBottom: 8 }}>Payment method</div>
            <div className="pay-methods">
              {methods.map((m) => (
                <button key={m} className={"pay-chip" + (method === m ? " on" : "")} onClick={() => setMethod(m)}>{m}</button>
              ))}
            </div>
          </div>
          <div className="beta-note">
            <b>Beta 壳子：</b>当前为免费邀请制内测，不产生真实扣款。正式收费将接入 Paddle（海外）+ 支付宝/微信（国内），届时此弹窗变为真实支付。
          </div>
          <button className="btn btn-dark" style={{ width: "100%" }} onClick={() => onConfirm(order)}>
            <IconCheck /> Confirm {method} · ${order.price.toFixed(2)}
          </button>
        </div>
      </div>
    </div>
  );
}

function EmptyState({ title, sub }) {
  return (
    <div className="empty">
      <span className="serif">"{title}"</span>
      <span>{sub}</span>
    </div>
  );
}

Object.assign(window, {
  ModelBadge, Seg, PromptAssistant, CostBar, TemplateCard, GalleryCard, PlanCard, PackButton, CheckoutModal, EmptyState,
});
