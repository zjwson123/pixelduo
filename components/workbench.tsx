"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { signOut } from "next-auth/react";
import Link from "next/link";
import { estimateGenerationCost, type ModelId, type Quality } from "@/lib/cost";
import { PLANS, PACKS } from "@/lib/catalog";

interface Me {
  credits: number;
  plan: string;
  planRenewsAt: string | null;
  emailVerified: string | null;
  role: string;
  name: string;
  email: string;
}

interface Template {
  id: string;
  cat: string;
  title: string;
  prompt: string;
  model: string;
  quality: string;
  credits: number;
  img: string;
}

interface GalleryImage {
  id: string;
  url: string;
  model: string;
  quality: string;
  prompt: string;
  credits: number;
  createdAt: string;
}

interface LedgerRow {
  id: string;
  type: string;
  creditsDelta: number;
  balanceAfter: number;
  note: string | null;
  createdAt: string;
}

interface ExpiringCredit {
  id: string;
  source: string;
  remaining: number;
  expiresAt: string;
  daysLeft: number;
}

interface JobStatus {
  id: string;
  status: string;
  model: string;
  quality: string;
  count: number;
  prompt: string;
  costCredits: number;
  images: string[];
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
}

type Tab = "create" | "explore" | "gallery" | "ledger" | "orders" | "pricing";

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "create", label: "Create" },
  { id: "explore", label: "Explore" },
  { id: "gallery", label: "Gallery" },
  { id: "ledger", label: "Ledger" },
  { id: "orders", label: "Orders" },
  { id: "pricing", label: "Pricing" },
];

const MODEL_OPTIONS: Array<{ value: ModelId; label: string }> = [
  { value: "gpt", label: "GPT Image 2" },
  { value: "seedream", label: "Seedream 5" },
  { value: "both", label: "Both ⇄" },
];

const QUALITY_OPTIONS: Array<{ value: Quality; label: string }> = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
];

const COUNT_OPTIONS = [1, 2, 4];

const STYLE_HINTS = [
  "soft studio lighting, high detail",
  "editorial, magazine quality",
  "cyberpunk, neon accents",
  "minimal, warm neutral palette",
];

const LEDGER_LABELS: Record<string, string> = {
  SIGNUP_BONUS: "Signup bonus",
  CHECKIN: "Daily check-in",
  PURCHASE: "Credit pack",
  SUBSCRIPTION: "Plan subscription",
  PRE_AUTH: "Generation (pre-auth)",
  SETTLE: "Generation settled",
  REFUND: "Refund (failure)",
  REVOKE: "Refund (payment)",
  EXPIRE: "Expired",
  ADMIN: "Adjustment",
};

interface OrderRow {
  id: string;
  kind: "pack" | "plan";
  provider: string;
  amountUsd: number;
  credits: number;
  planId: string | null;
  status: string;
  createdAt: string;
  paidAt: string | null;
}

type Locale = "en" | "zh";
const LOCALE_STRINGS: Record<Locale, { tabs: Record<Tab, string>; credits: string; topUp: string; signOut: string; generate: string; generating: string; beta: string; orderStatus: Record<string, string> }> = {
  en: {
    tabs: { create: "Create", explore: "Explore", gallery: "Gallery", ledger: "Ledger", orders: "Orders", pricing: "Pricing" },
    credits: "credits",
    topUp: "Top up",
    signOut: "Sign out",
    generate: "Generate",
    generating: "Generating…",
    beta: "Beta · free",
    orderStatus: { paid: "Paid", pending: "Pending", refunded: "Refunded" },
  },
  zh: {
    tabs: { create: "创作", explore: "灵感库", gallery: "画廊", ledger: "账本", orders: "订单", pricing: "定价" },
    credits: "积分",
    topUp: "充值",
    signOut: "退出",
    generate: "生成",
    generating: "生成中…",
    beta: "Beta · 免费",
    orderStatus: { paid: "已支付", pending: "待支付", refunded: "已退款" },
  },
};

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const data = (await res.json()) as T & { ok?: boolean; error?: string };
  if (!data.ok) throw new Error(data.error ?? "request failed");
  return data;
}

function Icon({ d, size = 16 }: { d: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d={d} />
    </svg>
  );
}

function Seg<T extends string | number>({ options, value, onChange, tone }: {
  options: Array<{ value: T; label: string }>;
  value: T;
  onChange: (v: T) => void;
  tone?: "gpt" | "seed";
}) {
  return (
    <div className="seg" role="tablist">
      {options.map((o) => (
        <button
          key={String(o.value)}
          className={(value === o.value ? "on" : "") + (tone && value === o.value ? ` ${tone}` : "")}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function ModelPill({ model }: { model: string }) {
  const cls = model === "gpt" ? "gpt" : "seed";
  return (
    <span className={`model-pill ${cls}`}>
      <i></i>
      {model === "gpt" ? "GPT Image 2" : "Seedream 5"}
    </span>
  );
}

export function Workbench() {
  const [locale, setLocale] = useState<Locale>("en");
  useEffect(() => {
    const saved = localStorage.getItem("pd-locale");
    if (saved === "zh" || saved === "en") setLocale(saved);
  }, []);
  const t = LOCALE_STRINGS[locale];
  const switchLocale = (l: Locale) => {
    setLocale(l);
    localStorage.setItem("pd-locale", l);
  };

  const [tab, setTab] = useState<Tab>("create");
  const [me, setMe] = useState<Me | null>(null);
  const [prompt, setPrompt] = useState("a minimalist ceramic coffee mug on a warm beige background");
  const [model, setModel] = useState<ModelId>("gpt");
  const [quality, setQuality] = useState<Quality>("medium");
  const [count, setCount] = useState(1);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [cat, setCat] = useState("全部");
  const [gallery, setGallery] = useState<GalleryImage[]>([]);
  const [ledger, setLedger] = useState<LedgerRow[]>([]);
  const [orders, setOrders] = useState<OrderRow[]>([]);
  const [expiring, setExpiring] = useState<ExpiringCredit[]>([]);
  const [activeJob, setActiveJob] = useState<JobStatus | null>(null);
  const [assistantOut, setAssistantOut] = useState("");
  const [toast, setToast] = useState("");
  const [checkout, setCheckout] = useState<null | { kind: "pack" | "plan"; itemId: string; name: string; price: number; credits: number }>(null);
  const [method, setMethod] = useState("Card");
  const idemKeyRef = useRef<string | null>(null);

  const cost = estimateGenerationCost(model, quality, count);

  const refreshMe = useCallback(async () => {
    try {
      const data = await api<{ user: Me }>("/api/me");
      setMe(data.user);
    } catch {
      // ignore
    }
  }, []);

  const refreshGallery = useCallback(async () => {
    try {
      const data = await api<{ images: GalleryImage[] }>("/api/gallery");
      setGallery(data.images);
    } catch {
      // ignore
    }
  }, []);

  const refreshLedger = useCallback(async () => {
    try {
      const data = await api<{ entries: LedgerRow[] }>("/api/ledger");
      setLedger(data.entries);
    } catch {
      // ignore
    }
  }, []);

  const refreshOrders = useCallback(async () => {
    try {
      const data = await api<{ orders: OrderRow[] }>("/api/orders");
      setOrders(data.orders);
    } catch {
      // ignore
    }
  }, []);

  const resendVerification = async () => {
    try {
      await api("/api/auth/request-verification", { method: "POST" });
      setToast("Verification email sent — check your inbox.");
    } catch (e) {
      setToast(e instanceof Error ? e.message : "Failed to send verification email");
    }
  };

  const friendlyError = (e: unknown) => {
    const msg = e instanceof Error ? e.message : "";
    if (msg === "verify-email-required") return "Verify your email first to start generating.";
    if (msg === "insufficient-credits") return "Insufficient credits — top up first";
    return msg || "Something went wrong";
  };

  useEffect(() => {
    refreshMe();
    refreshGallery();
    refreshLedger();
    refreshOrders();
    api<{ expiring: ExpiringCredit[] }>("/api/credits/expiring")
      .then((d) => setExpiring(d.expiring))
      .catch(() => undefined);
    api<{ templates: Template[] }>("/api/templates")
      .then((d) => setTemplates(d.templates))
      .catch(() => undefined);
  }, [refreshMe, refreshGallery, refreshLedger, refreshOrders]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(""), 2600);
    return () => clearTimeout(t);
  }, [toast]);

  // Poll active job until terminal state.
  useEffect(() => {
    if (!activeJob) return;
    if (activeJob.status === "done" || activeJob.status === "failed") {
      if (activeJob.status === "failed") setToast("Generation failed — credits refunded.");
      refreshMe();
      refreshGallery();
      refreshLedger();
      refreshOrders();
      return;
    }
    const t = setTimeout(async () => {
      try {
        const data = await api<{ job: JobStatus }>(`/api/jobs/${activeJob.id}`);
        setActiveJob(data.job);
      } catch {
        // keep last state
      }
    }, 2500);
    return () => clearTimeout(t);
  }, [activeJob, refreshMe, refreshGallery, refreshLedger, refreshOrders]);

  const generate = async () => {
    if (!prompt.trim()) return setToast("Write a prompt first");
    if (me && !me.emailVerified) return setToast("Verify your email first to start generating.");
    if (me && me.credits < cost.totalCredits) return setToast("Insufficient credits — top up first");
    setAssistantOut("");
    try {
      if (!idemKeyRef.current) idemKeyRef.current = crypto.randomUUID();
      const data = await api<{ jobId: string }>("/api/generate", {
        method: "POST",
        body: JSON.stringify({ prompt: prompt.trim(), model, quality, count, idempotencyKey: idemKeyRef.current }),
      });
      idemKeyRef.current = null;
      const poll = await api<{ job: JobStatus }>(`/api/jobs/${data.jobId}`);
      setActiveJob(poll.job);
    } catch (e) {
      // keep idemKeyRef so a retry reuses the same key and never double-charges
      setToast(friendlyError(e));
    }
  };

  const runAssistant = async (mode: string) => {
    try {
      const data = await api<{ text: string; offline: boolean }>("/api/assistant", {
        method: "POST",
        body: JSON.stringify({ prompt, mode }),
      });
      setAssistantOut(data.text + (data.offline ? "\n\n(offline mode — DeepSeek key not configured)" : ""));
    } catch {
      setToast("Assistant unavailable");
    }
  };

  const pickTemplate = (t: Template) => {
    setPrompt(t.prompt);
    setModel(t.model as ModelId);
    if (t.quality !== "standard") setQuality(t.quality as Quality);
    setTab("create");
    setToast("Template applied");
  };

  const checkin = async () => {
    try {
      const data = await api<{ claimed: boolean; credits: number }>("/api/checkin", { method: "POST" });
      setToast(data.claimed ? `+${data.credits} credits via daily check-in` : "Already checked in today");
      refreshMe();
      refreshLedger();
    } catch (e) {
      setToast(friendlyError(e));
    }
  };

  const openCheckout = (kind: "pack" | "plan", itemId: string) => {
    if (kind === "pack") {
      const p = PACKS.find((x) => x.id === itemId);
      if (!p) return;
      setCheckout({ kind, itemId, name: `Credit pack · ${p.credits}`, price: p.price, credits: p.credits });
    } else {
      const pl = PLANS.find((x) => x.id === itemId);
      if (!pl) return;
      setCheckout({ kind, itemId, name: `${pl.name} plan`, price: pl.price, credits: pl.credits });
    }
  };

  const confirmCheckout = async () => {
    if (!checkout) return;
    try {
      const data = await api<{ status: string; mock?: boolean; checkoutUrl?: string }>("/api/checkout", {
        method: "POST",
        body: JSON.stringify({ kind: checkout.kind, itemId: checkout.itemId }),
      });
      if (data.checkoutUrl) {
        window.location.href = data.checkoutUrl;
        return;
      }
      setToast(data.status === "paid" ? `Beta mock paid — +${checkout.credits} credits` : "Order created (pending)");
      setCheckout(null);
      refreshMe();
      refreshLedger();
      refreshOrders();
    } catch (e) {
      setToast(e instanceof Error ? e.message : "Checkout failed");
    }
  };

  const filteredTemplates = cat === "全部" ? templates : templates.filter((t) => t.cat === cat);
  const cats = ["全部", ...Array.from(new Set(templates.map((t) => t.cat)))];

  const generating = activeJob !== null && (activeJob.status === "queued" || activeJob.status === "running");
  const genLabel = generating
    ? activeJob!.status === "queued"
      ? "Queued…"
      : `Drawing with ${activeJob!.model === "both" ? "both engines" : activeJob!.model === "gpt" ? "GPT Image 2" : "Seedream 5"}…`
    : model === "both"
      ? "Generate both engines"
      : "Generate";

  return (
    <div>
      <header className="topbar">
        <Link className="logo" href="/">
          <span className="logo-mark"><i></i><i></i></span>
          PixelDuo
        </Link>
        <nav className="tabs">
          {TABS.map((tb) => (
            <button key={tb.id} className={`tab${tab === tb.id ? " active" : ""}`} onClick={() => setTab(tb.id)}>
              <span>{t.tabs[tb.id]}</span>
            </button>
          ))}
        </nav>
        <div className="top-right">
          <button className="balance" onClick={checkin} title="Daily check-in +2">
            <span className="coin">P</span>
            {me?.credits ?? "…"} <small>{t.credits}</small>
          </button>
          <button className="btn btn-ghost btn-sm" onClick={() => setTab("pricing")}>{t.topUp}</button>
          <button className="btn btn-ghost btn-sm" onClick={() => switchLocale(locale === "en" ? "zh" : "en")}>{locale === "en" ? "中文" : "EN"}</button>
          <Link className="btn btn-ghost btn-sm" href="/account/security">Security</Link>
          <Link className="btn btn-ghost btn-sm" href="/account/api">API Keys</Link>
          {me?.role === "admin" && <Link className="btn btn-ghost btn-sm" href="/admin">Admin</Link>}
          <button className="btn btn-ghost btn-sm" onClick={() => signOut({ callbackUrl: "/" })}>{t.signOut}</button>
        </div>
      </header>

      {me && !me.emailVerified && (
        <div className="verify-banner">
          <span>⚠️ Verify your email to unlock generation and your 30 free credits.</span>
          <button className="btn btn-ghost btn-sm" onClick={resendVerification}>Resend email</button>
        </div>
      )}

      {expiring.length > 0 && (
        <div className="expiry-banner">
          <span>
            ⏳ {expiring.reduce((acc, g) => acc + g.remaining, 0)} credits expire in{" "}
            {Math.min(...expiring.map((g) => g.daysLeft))} day
            {Math.min(...expiring.map((g) => g.daysLeft)) > 1 ? "s" : ""} — use them or top up.
          </span>
          <button className="btn btn-ghost btn-sm" onClick={() => setTab("pricing")}>Top up</button>
        </div>
      )}

      <main className="main">
        {tab === "create" && (
          <>
            <div className="page-head">
              <div>
                <h1>Create</h1>
                <p>One prompt, two engines — see the cost before you generate.</p>
              </div>
              <span className="chip on" style={{ cursor: "default" }}>{t.beta}</span>
            </div>
            <div className="create-grid">
              <div className="card composer">
                <div>
                  <div className="field-label">Prompt</div>
                  <div className="prompt-box">
                    <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Describe what you want to create…" />
                    <div className="prompt-meta">
                      <span>{prompt.length} chars</span>
                      <span>EN prompts work best</span>
                    </div>
                  </div>
                  <div className="chips" style={{ marginTop: 8 }}>
                    {STYLE_HINTS.map((s) => (
                      <button key={s} className="chip" onClick={() => setPrompt(prompt ? `${prompt}, ${s}` : s)}>{s}</button>
                    ))}
                  </div>
                </div>

                <div className="assistant">
                  <div className="assistant-head">
                    <span className="spark">✦</span>
                    Prompt assistant · DeepSeek
                    <span style={{ marginLeft: "auto", fontWeight: 500, color: "var(--ink-3)" }}>free</span>
                  </div>
                  <div className="assistant-body">
                    <div className="assist-actions">
                      {[["expand", "扩写"], ["translate", "翻译成英文"], ["style", "风格化"], ["inspire", "灵感"]].map(([mode, label]) => (
                        <button key={mode} className="mini-btn" onClick={() => runAssistant(mode)}>✦ {label}</button>
                      ))}
                    </div>
                    {assistantOut && (
                      <div className="assistant-output">
                        {assistantOut}
                        <button className="mini-btn" style={{ marginTop: 8 }} onClick={() => { setPrompt(assistantOut.split("\n\n")[0]); setAssistantOut(""); }}>
                          ✓ Use this prompt
                        </button>
                      </div>
                    )}
                  </div>
                </div>

                <div>
                  <div className="field-label" style={{ marginBottom: 8 }}>Model</div>
                  <Seg options={MODEL_OPTIONS} value={model} onChange={setModel} tone={model === "gpt" ? "gpt" : model === "seedream" ? "seed" : undefined} />
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
                  <div style={{ width: 140 }}><Seg options={COUNT_OPTIONS.map((c) => ({ value: c, label: String(c) }))} value={count} onChange={setCount} /></div>
                </div>

                <div className="costbar">
                  <span>
                    {model === "seedream" ? "Seedream 5 · standard" : model === "both" ? `GPT ${cost.perPair.gpt.label} + Seedream` : `GPT Image 2 · ${cost.perPair.gpt.label}`}
                    <span className="amount"> {cost.totalCredits} <small>credits ≈ ${cost.totalUsd.toFixed(2)}</small></span>
                  </span>
                  {me && me.credits >= cost.totalCredits ? (
                    <span style={{ color: "var(--ink-2)" }}>Balance {me.credits}</span>
                  ) : (
                    <span className="warn">Insufficient credits</span>
                  )}
                </div>

                <button className={`generate${model === "both" ? " both" : ""}`} disabled={generating} onClick={generate}>
                  {generating ? t.generating : genLabel}
                </button>
              </div>

              <div className="card results">
                {generating ? (
                  <div className="gen-steps">
                    <div className="gen-step active"><span className="dot"></span>{genLabel}</div>
                    <div className="gen-step"><span className="dot"></span>Charged {activeJob!.costCredits} credits (pre-auth) — refunded automatically on failure</div>
                  </div>
                ) : activeJob && activeJob.status === "failed" ? (
                  <div className="empty">
                    <span className="serif">Generation failed</span>
                    <span>{activeJob.error ?? "Unknown error"} — credits refunded.</span>
                  </div>
                ) : activeJob && activeJob.status === "done" ? (
                  <>
                    <div className="results-head">
                      <h2>Latest results</h2>
                      <span className="count">{activeJob.images.length} images · {activeJob.costCredits} credits</span>
                    </div>
                    <div className="results-grid">
                      {activeJob.images.map((src, i) => (
                        <div key={i} className="result-card">
                          <img src={src} alt={activeJob.prompt} />
                          {me?.plan === "free" && <div className="wm-badge">PixelDuo · AI 生成</div>}
                          <div className="result-meta">
                            <span className="model-pill"><i></i>{activeJob.model === "both" ? (i % 2 === 0 ? "GPT" : "Seedream") : activeJob.model === "gpt" ? "GPT" : "Seedream"}</span>
                            <span style={{ marginLeft: "auto" }}>{Math.round(activeJob.costCredits / activeJob.count)} cr</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </>
                ) : gallery.length === 0 ? (
                  <div className="empty">
                    <span className="serif">Your canvas is empty</span>
                    <span>Type a prompt, pick an engine, and press Generate — the cost shows up before you commit.</span>
                  </div>
                ) : (
                  <>
                    <div className="results-head">
                      <h2>Recent images</h2>
                      <span className="count">{gallery.length} total</span>
                    </div>
                    <div className="results-grid">
                      {gallery.slice(0, 8).map((g) => (
                        <div key={g.id} className="result-card">
                          <img src={g.url} alt={g.prompt} />
                          {me?.plan === "free" && <div className="wm-badge">PixelDuo · AI 生成</div>}
                          <div className="result-meta">
                            <ModelPill model={g.model} />
                            <span style={{ marginLeft: "auto" }}>{g.credits} cr</span>
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
              {cats.map((c) => (
                <button key={c} className={`chip${cat === c ? " on" : ""}`} onClick={() => setCat(c)}>{c}</button>
              ))}
            </div>
            <div className="tmpl-grid">
              {filteredTemplates.map((t) => (
                <div key={t.id} className="card tmpl-card" onClick={() => pickTemplate(t)}>
                  <img src={t.img} alt={t.title} />
                  <div className="tmpl-body">
                    <h3>{t.title}</h3>
                    <p>{t.prompt}</p>
                    <div className="tmpl-foot">
                      <ModelPill model={t.model} />
                      <span>{t.credits} credits</span>
                      <span className="spacer"></span>
                      <span style={{ color: "var(--indigo)", fontWeight: 700 }}>Use →</span>
                    </div>
                  </div>
                </div>
              ))}
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
            {gallery.length === 0 ? (
              <div className="card"><div className="empty"><span className="serif">Nothing here yet</span><span>Generated images will appear here.</span></div></div>
            ) : (
              <div className="gallery-grid">
                {gallery.map((g) => (
                  <div key={g.id} className="card gal-card">
                    <img src={g.url} alt={g.prompt} />
                    <div className="gal-body">
                      <div className="prompt">{g.prompt}</div>
                      <div className="gal-meta">
                        <ModelPill model={g.model} />
                        <span>{g.credits} cr</span>
                        <span className="spacer"></span>
                        <span>{new Date(g.createdAt).toLocaleString()}</span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        {tab === "ledger" && (
          <>
            <div className="page-head">
              <div>
                <h1>Ledger</h1>
                <p>Every credit movement, in one transparent log. Balance = sum of entries.</p>
              </div>
              <span className="balance" style={{ cursor: "default" }}>
                <span className="coin">P</span>
                {me?.credits ?? 0} <small>credits</small>
              </span>
            </div>
            <div className="table-wrap">
              <table className="ledger">
                <thead>
                  <tr><th>Time</th><th>Type</th><th>Note</th><th>Δ</th><th>Balance</th></tr>
                </thead>
                <tbody>
                  {ledger.map((row) => (
                    <tr key={row.id}>
                      <td>{new Date(row.createdAt).toLocaleString()}</td>
                      <td>{LEDGER_LABELS[row.type] ?? row.type}</td>
                      <td>{row.note ?? ""}</td>
                      <td className={row.creditsDelta >= 0 ? "pos" : "neg"}>{row.creditsDelta >= 0 ? `+${row.creditsDelta}` : row.creditsDelta}</td>
                      <td>{row.balanceAfter}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}

        {tab === "orders" && (
          <>
            <div className="page-head">
              <div>
                <h1>Orders</h1>
                <p>Your purchases and payment status.</p>
              </div>
              <span className="balance" style={{ cursor: "default" }}>
                <span className="coin">P</span>
                {me?.credits ?? 0} <small>credits</small>
              </span>
            </div>
            <div className="table-wrap">
              <table className="ledger">
                <thead>
                  <tr><th>Time</th><th>Item</th><th>Amount</th><th>Credits</th><th>Status</th><th>Provider</th></tr>
                </thead>
                <tbody>
                  {orders.length === 0 && (
                    <tr><td colSpan={6} style={{ textAlign: "center", color: "var(--ink-3)" }}>No orders yet.</td></tr>
                  )}
                  {orders.map((o) => (
                    <tr key={o.id}>
                      <td>{new Date(o.createdAt).toLocaleString()}</td>
                      <td>{o.kind === "plan" ? `${o.planId ?? "plan"} plan` : `${o.credits} credits pack`}</td>
                      <td>${o.amountUsd.toFixed(2)}</td>
                      <td>+{o.credits}</td>
                      <td>
                        <span className={`status status-${o.status}`}>
                          {t.orderStatus[o.status] ?? o.status}
                        </span>
                      </td>
                      <td>{o.provider}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
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
                <div style={{ fontWeight: 800, fontSize: 18 }}>{me?.credits ?? 0} credits</div>
                <div style={{ fontSize: 12.5, color: "var(--ink-2)" }}>{me?.plan ?? "free"} plan · daily check-in +2</div>
              </div>
              <span style={{ marginLeft: "auto", fontSize: 12.5, color: "var(--ink-3)" }}>Beta 壳子 · 不产生真实扣款</span>
            </div>
            <div className="pricing-grid">
              {PLANS.map((p) => (
                <div key={p.id} className={`card plan-card${p.featured ? " featured" : ""}`}>
                  <h3>{p.name}</h3>
                  <div className="price">${p.price}<small> / month</small></div>
                  <div style={{ fontSize: 12.5, color: "var(--ink-2)" }}>{p.credits} credits</div>
                  <ul>{p.features.map((f) => <li key={f}>{f}</li>)}</ul>
                  <button className={p.featured ? "btn btn-dark" : "btn btn-ghost"} onClick={() => openCheckout("plan", p.id)}>
                    {p.id === me?.plan ? "Current plan" : p.price === 0 ? "Free" : "Choose"}
                  </button>
                </div>
              ))}
            </div>
            <div className="field-label" style={{ marginBottom: 10 }}>Top-up packs · valid 12 months</div>
            <div className="pack-row">
              {PACKS.map((p) => (
                <button key={p.id} className="pack" onClick={() => openCheckout("pack", p.id)}>
                  <span className="price">${p.price}</span>
                  <span className="credits">{p.credits} credits</span>
                  {p.bonus && <span className="bonus">{p.bonus} bonus</span>}
                </button>
              ))}
            </div>
          </>
        )}
      </main>

      {checkout && (
        <div className="overlay" onClick={() => setCheckout(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h2>Checkout · 结账壳子</h2>
              <button className="icon-btn" onClick={() => setCheckout(null)}>✕</button>
            </div>
            <div className="modal-body">
              <div className="order-row"><span className="lbl">Item</span><span className="val">{checkout.name}</span></div>
              <div className="order-row"><span className="lbl">Credits</span><span className="val">{checkout.credits}</span></div>
              <div className="order-row order-total"><span className="lbl">Total</span><span className="val">${checkout.price.toFixed(2)}</span></div>
              <div>
                <div className="field-label" style={{ marginBottom: 8 }}>Payment method</div>
                <div className="pay-methods">
                  {["Card", "PayPal", "Alipay", "WeChat Pay"].map((m) => (
                    <button key={m} className={`pay-chip${method === m ? " on" : ""}`} onClick={() => setMethod(m)}>{m}</button>
                  ))}
                </div>
              </div>
              <div className="beta-note">
                <b>Beta 壳子：</b>当前为免费邀请制内测，不产生真实扣款。正式收费将接入 Paddle（海外）+ 支付宝/微信（国内）。
              </div>
              <button className="btn btn-dark" style={{ width: "100%" }} onClick={confirmCheckout}>
                ✓ Confirm {method} · ${checkout.price.toFixed(2)}
              </button>
            </div>
          </div>
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
