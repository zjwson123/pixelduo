"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { FEEDBACK_CATEGORIES, FEEDBACK_MESSAGE_MAX, FEEDBACK_MESSAGE_MIN, type FeedbackCategory } from "@/lib/feedback-meta";

type Locale = "en" | "zh";

interface FeedbackRow {
  id: string;
  category: string;
  message: string;
  status: string;
  createdAt: string;
}

// Copy lives here rather than in lib/i18n.ts: the landing page and workbench
// each carry their own table, and this page is self-contained.
const T = {
  en: {
    lang: "中文",
    title: "Say something",
    sub: "A bug, an idea, a billing question — anything. A human reads every message and replies by email.",
    faqHint: "Looking for an answer right now? The common questions are on the home page.",
    faqLink: "Common questions",
    category: "What is it about?",
    message: "Your message",
    messagePlaceholder:
      "What you did, what you expected, what happened instead — and the prompt or page involved. Concrete beats long.",
    email: "Your email",
    emailHint: "Only used to reply.",
    signedInAs: "Sending as {email} — that is where the answer goes.",
    submit: "Send",
    sending: "Sending…",
    note:
      "Attached automatically so we can find what you saw: your account, plan, interface language and the page you came from. Stored with your account and deleted with it.",
    done: "Received.",
    doneBody: "We will reply to {email}. Your reference is {ref}.",
    doneAnon: "Your reference is {ref}.",
    again: "Write another",
    back: "Back to the studio",
    home: "Back to the home page",
    tooShort: "A little more detail, please — at least {n} characters.",
    tooLong: "That is past the {n} character limit.",
    needEmail: "Add an email address so we can reply.",
    rateLimited: "That is a lot of messages just now — please try again in a few minutes.",
    failed: "Could not send that. Please try again.",
    chars: "characters",
    mineTitle: "Messages you have sent",
    statusNew: "Waiting",
    statusDone: "Handled",
  },
  zh: {
    lang: "EN",
    title: "留言反馈",
    sub: "问题、建议、计费——都可以。每条留言都会有人读，并用邮件回复你。",
    faqHint: "想立刻找答案？常见问题在首页。",
    faqLink: "常见问题",
    category: "关于什么？",
    message: "具体内容",
    messagePlaceholder: "你做了什么、期望什么、实际发生了什么，以及涉及的提示词或页面。具体一点比写长更有用。",
    email: "你的邮箱",
    emailHint: "仅用于回复。",
    signedInAs: "以 {email} 提交，我们会回复到这个邮箱。",
    submit: "发送",
    sending: "发送中…",
    note:
      "系统会自动附上你的账号、套餐、界面语言和来源页面，方便定位你看到的问题；留言随账号存留，注销账号时一并删除。",
    done: "收到。",
    doneBody: "我们会回复到 {email}。编号 {ref}。",
    doneAnon: "编号 {ref}。",
    again: "再写一条",
    back: "返回工作台",
    home: "返回首页",
    tooShort: "再多写一点吧——至少 {n} 个字符。",
    tooLong: "超出 {n} 个字符上限了。",
    needEmail: "留一个邮箱，我们才能回复你。",
    rateLimited: "刚刚提交得有点频繁，请过几分钟再试。",
    failed: "没能发送出去，请重试。",
    chars: "字符",
    mineTitle: "你提交过的留言",
    statusNew: "待处理",
    statusDone: "已处理",
  },
} as const;

function fill(template: string, vars: Record<string, string>): string {
  return Object.entries(vars).reduce((acc, [k, v]) => acc.replace(`{${k}}`, v), template);
}

// Which page the reporter came from, for the context block an operator reads.
// Read at submit time from the URL rather than through useSearchParams (which
// would force a Suspense boundary on this otherwise-static page), and reduced
// to a bare PATHNAME: a referrer or a query string can carry a reset token, and
// that must never end up in an operator's inbox as "context". Falls back to the
// form itself when there is nothing trustworthy to say.
function sourceHint(): string {
  const raw = (() => {
    try {
      const from = new URLSearchParams(window.location.search).get("from");
      if (from) return from;
      if (document.referrer) return new URL(document.referrer).pathname;
    } catch {
      // fall through to the default below
    }
    return "/feedback";
  })();
  return /^\/[A-Za-z0-9/_-]{0,100}$/.test(raw) ? raw : "/feedback";
}

export default function FeedbackPage() {
  const [locale, setLocale] = useState<Locale>("en");
  const [me, setMe] = useState<{ email: string } | null>(null);
  const [category, setCategory] = useState<FeedbackCategory>("idea");
  const [message, setMessage] = useState("");
  const [email, setEmail] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ id: string; email: string } | null>(null);
  const [mine, setMine] = useState<FeedbackRow[]>([]);

  const t = T[locale];

  const loadMine = useCallback(async () => {
    try {
      const res = await fetch("/api/feedback");
      const data = await res.json();
      if (data.ok) setMine(data.feedback as FeedbackRow[]);
    } catch {
      // The history is a convenience; never block the form on it.
    }
  }, []);

  useEffect(() => {
    const saved = localStorage.getItem("pd-lang");
    if (saved === "zh" || saved === "en") setLocale(saved);
  }, []);

  useEffect(() => {
    fetch("/api/me")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data?.ok && data.user?.email) {
          setMe({ email: data.user.email });
          loadMine();
        }
      })
      .catch(() => undefined);
  }, [loadMine]);

  const switchLocale = (l: Locale) => {
    setLocale(l);
    localStorage.setItem("pd-lang", l);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    const trimmed = message.trim();
    if (trimmed.length < FEEDBACK_MESSAGE_MIN) {
      setError(fill(t.tooShort, { n: String(FEEDBACK_MESSAGE_MIN) }));
      return;
    }
    if (trimmed.length > FEEDBACK_MESSAGE_MAX) {
      setError(fill(t.tooLong, { n: String(FEEDBACK_MESSAGE_MAX) }));
      return;
    }
    if (!me && !email.trim()) {
      setError(t.needEmail);
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          category,
          message: trimmed,
          ...(me ? {} : { email: email.trim() }),
          page: sourceHint(),
          locale,
        }),
      });
      const data = await res.json();
      if (!data.ok) {
        if (data.error === "rate-limited") throw new Error(t.rateLimited);
        if (typeof data.error === "string" && data.error.startsWith("invalid-input")) {
          throw new Error(data.error.replace(/^invalid-input:\s*/, ""));
        }
        throw new Error(t.failed);
      }
      setDone({ id: String(data.id), email: me?.email ?? email.trim() });
      loadMine();
    } catch (err) {
      setError(err instanceof Error ? err.message : t.failed);
    }
    setBusy(false);
  };

  const counterStyle = message.length > FEEDBACK_MESSAGE_MAX ? { color: "var(--red)" } : undefined;

  return (
    <div className="auth-wrap">
      <div className="auth-card" style={{ maxWidth: 560 }}>
        <div className="row">
          <span className="logo-mark"><i></i><i></i></span>
          <span style={{ fontWeight: 800 }}>PixelDuo</span>
          <button
            className="btn btn-ghost btn-sm"
            style={{ marginLeft: "auto" }}
            onClick={() => switchLocale(locale === "en" ? "zh" : "en")}
          >
            {t.lang}
          </button>
        </div>

        {done ? (
          <>
            <h1 style={{ marginTop: 18 }}>{t.done}</h1>
            <p className="sub">
              {fill(done.email ? t.doneBody : t.doneAnon, {
                email: done.email,
                ref: `#${done.id.slice(-8)}`,
              })}
            </p>
            <button
              type="button"
              className="btn btn-ghost btn-block"
              onClick={() => {
                setDone(null);
                setMessage("");
                setCategory("idea");
              }}
            >
              {t.again}
            </button>
            <div className="auth-foot">
              <Link className="link" href={me ? "/studio" : "/"}>{me ? t.back : t.home}</Link>
            </div>
          </>
        ) : (
          <form onSubmit={submit}>
            <h1 style={{ marginTop: 18 }}>{t.title}</h1>
            <p className="sub">{t.sub}</p>
            {error && <div className="form-error">{error}</div>}

            <div className="field">
              <label>{t.category}</label>
              <div className="chips" style={{ marginBottom: 4 }}>
                {FEEDBACK_CATEGORIES.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    className={`chip${category === c.id ? " on" : ""}`}
                    onClick={() => setCategory(c.id)}
                  >
                    {c[locale]}
                  </button>
                ))}
              </div>
            </div>

            <div className="field">
              <label htmlFor="feedback-message">{t.message}</label>
              <textarea
                id="feedback-message"
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder={t.messagePlaceholder}
                rows={6}
                maxLength={FEEDBACK_MESSAGE_MAX + 200}
                required
              />
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "var(--ink-3)", marginTop: 6 }}>
                <span>{t.chars}</span>
                <span style={counterStyle}>{message.length}/{FEEDBACK_MESSAGE_MAX}</span>
              </div>
            </div>

            {me ? (
              <p style={{ fontSize: 12.5, color: "var(--ink-3)", margin: "0 0 14px" }}>
                {fill(t.signedInAs, { email: me.email })}
              </p>
            ) : (
              <div className="field">
                <label htmlFor="feedback-email">{t.email}</label>
                <input
                  id="feedback-email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  autoComplete="email"
                />
                <p style={{ fontSize: 12, color: "var(--ink-3)", margin: "6px 0 0" }}>{t.emailHint}</p>
              </div>
            )}

            <button type="submit" className="btn btn-dark btn-block" disabled={busy}>
              {busy ? t.sending : t.submit}
            </button>

            <p style={{ fontSize: 11.5, color: "var(--ink-3)", marginTop: 14, lineHeight: 1.6 }}>{t.note}</p>
            <div className="auth-foot" style={{ marginTop: 12 }}>
              {t.faqHint} <Link className="link" href="/#faq">{t.faqLink}</Link>
            </div>
            <div className="auth-foot" style={{ marginTop: 8, fontSize: 12 }}>
              <Link className="link" href="/">PixelDuo</Link> · <Link className="link" href="/terms">Terms</Link> ·{" "}
              <Link className="link" href="/privacy">Privacy</Link>
            </div>

            {/* Signed-in senders get their own history: "did anyone read this?"
                is the question a feedback channel lives or dies on, and until
                now the only answer was the confirmation screen. */}
            {me && mine.length > 0 && (
              <div style={{ marginTop: 22, borderTop: "1px solid var(--line)", paddingTop: 14 }}>
                <div className="field-label" style={{ marginBottom: 8 }}>{t.mineTitle}</div>
                {mine.map((row) => (
                  <div key={row.id} style={{ display: "flex", gap: 8, alignItems: "baseline", fontSize: 12.5, marginBottom: 7 }}>
                    <span
                      className="chip"
                      style={{
                        cursor: "default",
                        flex: "none",
                        color: row.status === "done" ? "var(--ink-3)" : "var(--indigo)",
                        borderColor: row.status === "done" ? "var(--line)" : "var(--indigo)",
                      }}
                    >
                      {row.status === "done" ? t.statusDone : t.statusNew}
                    </span>
                    <span style={{ color: "var(--ink-2)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {row.message}
                    </span>
                    <span style={{ color: "var(--ink-3)", marginLeft: "auto", flex: "none" }}>
                      {new Date(row.createdAt).toLocaleDateString()}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </form>
        )}
      </div>
    </div>
  );
}
