"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { getModel } from "@/lib/model-registry";

interface AdminUser {
  id: string;
  email: string;
  name: string | null;
  role: string;
  credits: number;
  plan: string;
  emailVerified: string | null;
  totpEnabled: boolean;
  createdAt: string;
}

interface OrderRow {
  id: string;
  userId: string;
  kind: string;
  provider: string;
  amountUsd: number;
  credits: number;
  status: string;
  createdAt: string;
}

interface ImageRow {
  id: string;
  userId: string;
  model: string;
  prompt: string;
  createdAt: string;
}

interface FeedbackRow {
  id: string;
  userId: string | null;
  email: string;
  category: string;
  message: string;
  status: string;
  page: string | null;
  locale: string | null;
  plan: string | null;
  userAgent: string | null;
  createdAt: string;
  handledAt: string | null;
}

interface MailState {
  deliverable: boolean;
  lastAttempt: { at: string; ok: boolean; to: string; subject: string; response?: string; error?: string } | null;
}

interface NotifyState {
  webhook: boolean;
}

type Tab = "users" | "orders" | "images" | "feedback";

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const data = (await res.json()) as T & { ok?: boolean; error?: string };
  if (!data.ok) throw new Error(data.error ?? "request failed");
  return data;
}

export default function AdminPage() {
  const [tab, setTab] = useState<Tab>("users");
  const [q, setQ] = useState("");
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [orders, setOrders] = useState<OrderRow[]>([]);
  const [images, setImages] = useState<ImageRow[]>([]);
  // Server-side pages: the listing used to be the newest 50 with no way to go
  // further, so a report about an older image could not be located at all.
  const [imagesPage, setImagesPage] = useState(1);
  const [imagesTotal, setImagesTotal] = useState(0);
  const [imagesPageSize, setImagesPageSize] = useState(50);
  const [feedback, setFeedback] = useState<FeedbackRow[]>([]);
  const [unhandled, setUnhandled] = useState(0);
  // The inbox is paginated server-side (PAGE_SIZE per page). Dropping `total`
  // made an inbox of 60 look like an inbox of 50: the badge said "60 unhandled"
  // while the list showed 50, and a submission flood pushed the older reports
  // out of reach with no sign that anything was missing.
  const [feedbackPage, setFeedbackPage] = useState(1);
  const [feedbackTotal, setFeedbackTotal] = useState(0);
  const [feedbackPageSize, setFeedbackPageSize] = useState(50);
  const [mail, setMail] = useState<MailState>({ deliverable: true, lastAttempt: null });
  const [notify, setNotify] = useState<NotifyState>({ webhook: false });
  const [showHandled, setShowHandled] = useState(false);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");

  const refreshUsers = useCallback(async () => {
    try {
      const data = await api<{ users: AdminUser[] }>(`/api/admin/users?q=${encodeURIComponent(q)}`);
      setUsers(data.users);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "load failed");
    }
  }, [q]);

  const refreshOrders = useCallback(async () => {
    try {
      const data = await api<{ orders: OrderRow[] }>("/api/admin/orders");
      setOrders(data.orders);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "load failed");
    }
  }, []);

  const refreshImages = useCallback(async () => {
    try {
      const data = await api<{ images: ImageRow[]; total: number; page: number; pageSize: number }>(
        `/api/admin/images?page=${imagesPage}`,
      );
      setImages(data.images);
      setImagesTotal(data.total);
      setImagesPageSize(data.pageSize);
      // Echoed back: the route clamps ?page=, so a stale number cannot leave the
      // view pointing past the end after deletions.
      setImagesPage(data.page);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "load failed");
    }
  }, [imagesPage]);

  const refreshFeedback = useCallback(async () => {
    try {
      const data = await api<{
        feedback: FeedbackRow[];
        total: number;
        unhandled: number;
        page: number;
        pageSize: number;
        mail: MailState;
        notify: NotifyState;
      }>(`/api/admin/feedback?status=${showHandled ? "all" : "new"}&page=${feedbackPage}`);
      setFeedback(data.feedback);
      setUnhandled(data.unhandled);
      setFeedbackTotal(data.total);
      setFeedbackPageSize(data.pageSize);
      // Echoed back rather than assumed: the route clamps ?page=, so a stale
      // page number (rows handled on the last page) cannot leave the view
      // pointing past the end. Same value in, same value out — no loop.
      setFeedbackPage(data.page);
      setMail(data.mail);
      setNotify(data.notify);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "load failed");
    }
  }, [showHandled, feedbackPage]);

  const feedbackPages = Math.max(1, Math.ceil(feedbackTotal / feedbackPageSize));
  const feedbackFirst = (feedbackPage - 1) * feedbackPageSize + 1;
  const feedbackLast = (feedbackPage - 1) * feedbackPageSize + feedback.length;

  // The unhandled count drives the tab badge, so it is fetched on mount rather
  // than only after the operator opens the tab — otherwise new messages are
  // invisible until someone thinks to look.
  useEffect(() => {
    refreshFeedback();
  }, [refreshFeedback]);

  useEffect(() => {
    if (tab === "users") refreshUsers();
    if (tab === "orders") refreshOrders();
    if (tab === "images") refreshImages();
  }, [tab, refreshUsers, refreshOrders, refreshImages, imagesPage]);

  const adjustCredits = async (u: AdminUser) => {
    const raw = prompt(`Adjust credits for ${u.email} (positive = grant, negative = clawback):`);
    if (raw === null) return;
    const delta = Number(raw);
    if (!Number.isInteger(delta) || delta === 0) return;
    const note = prompt("Reason (shown in the user's ledger):") ?? "admin adjustment";
    // Confirm the magnitude before it lands (pass 71). Every other destructive
    // action in this console asks first; this one moves up to 1,000,000 credits
    // on a mistyped zero, and a lost response leaves the operator unsure
    // whether to repeat it.
    if (!confirm(`Apply ${delta > 0 ? "+" : ""}${delta} credits to ${u.email}?\nReason: ${note}`)) return;
    setErr("");
    try {
      const data = await api<{ credits: number }>(`/api/admin/users/${u.id}/credits`, {
        method: "POST",
        body: JSON.stringify({ delta, note }),
      });
      setMsg(`${u.email} → ${data.credits} credits`);
      refreshUsers();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "adjust failed");
    }
  };

  const toggleRole = async (u: AdminUser) => {
    // A single unconfirmed click used to promote a verified account to full
    // operator — mint credits to any account, delete accounts and images, read
    // every report — from a button sitting in the same dense row as Adjust and
    // Delete (pass 71). Demotion is the same click in reverse; ask in both
    // directions.
    const next = u.role === "admin" ? "user" : "admin";
    const question =
      next === "admin"
        ? `Promote ${u.email} to operator?\n\nOperators can mint credits to any account, delete accounts and images, and read every report.`
        : `Demote ${u.email} from operator?`;
    if (!confirm(question)) return;
    setErr("");
    try {
      await api(`/api/admin/users/${u.id}/role`, {
        method: "POST",
        body: JSON.stringify({ role: u.role === "admin" ? "user" : "admin" }),
      });
      refreshUsers();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "role change failed");
    }
  };

  const deleteUser = async (u: AdminUser) => {
    if (!confirm(`Delete ${u.email} and all their data? This cannot be undone.`)) return;
    setErr("");
    try {
      await api(`/api/admin/users/${u.id}`, { method: "DELETE" });
      refreshUsers();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "delete failed");
    }
  };

  const deleteImage = async (img: ImageRow) => {
    if (!confirm("Delete this image? (no credit refund)")) return;
    setErr("");
    try {
      await api(`/api/admin/images/${img.id}`, { method: "DELETE" });
      refreshImages();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "delete failed");
    }
  };

  const markHandled = async (row: FeedbackRow, status: "new" | "done") => {
    setErr("");
    try {
      await api(`/api/admin/feedback/${row.id}`, { method: "PATCH", body: JSON.stringify({ status }) });
      refreshFeedback();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "update failed");
    }
  };

  return (
    <div className="auth-wrap">
      <div className="auth-card" style={{ maxWidth: 900 }}>
        <div className="row">
          <span className="logo-mark"><i></i><i></i></span>
          <h1 style={{ fontWeight: 800, fontSize: 22, margin: 0 }}>PixelDuo Admin</h1>
        </div>
        <div className="row" style={{ marginTop: 14, gap: 8 }}>
          {(["users", "orders", "images", "feedback"] as Tab[]).map((t) => (
            <button
              key={t}
              className={`btn btn-sm ${tab === t ? "btn-dark" : "btn-ghost"}`}
              onClick={() => setTab(t)}
            >
              {t}
              {t === "feedback" && unhandled > 0 && (
                <span style={{ marginLeft: 6, padding: "1px 6px", borderRadius: 999, background: "var(--orange)", color: "#fff", fontSize: 11 }}>
                  {unhandled}
                </span>
              )}
            </button>
          ))}
          <Link className="btn btn-ghost btn-sm" href="/studio" style={{ marginLeft: "auto" }}>← Workbench</Link>
        </div>
        {err && <div className="form-error" style={{ marginTop: 10 }}>{err}</div>}
        {msg && <p style={{ color: "#2f9e44", margin: "8px 0" }}>{msg}</p>}

        {tab === "users" && (
          <div style={{ marginTop: 16 }}>
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search email or name…"
              style={{ width: "100%", padding: "10px 12px", borderRadius: 10, border: "1px solid rgba(0,0,0,0.15)" }}
            />
            <table className="ledger" style={{ width: "100%", marginTop: 12 }}>
              <thead>
                <tr><th>User</th><th>Role</th><th>Credits</th><th>Plan</th><th>Verified</th><th>2FA</th><th>Actions</th></tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id}>
                    <td>
                      <b>{u.name ?? "—"}</b>
                      <div style={{ fontSize: 12, color: "#7c829a" }}>{u.email}</div>
                    </td>
                    <td>{u.role}</td>
                    <td>{u.credits}</td>
                    <td>{u.plan}</td>
                    <td>{u.emailVerified ? "✓" : "—"}</td>
                    <td>{u.totpEnabled ? "✓" : "—"}</td>
                    <td>
                      <button className="btn btn-ghost btn-sm" onClick={() => adjustCredits(u)}>Adjust</button>{" "}
                      <button className="btn btn-ghost btn-sm" onClick={() => toggleRole(u)}>{u.role === "admin" ? "Demote" : "Promote"}</button>{" "}
                      <button className="btn btn-danger btn-sm" onClick={() => deleteUser(u)}>Delete</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {tab === "orders" && (
          <table className="ledger" style={{ width: "100%", marginTop: 16 }}>
            <thead>
              <tr><th>Order</th><th>User</th><th>Kind</th><th>Provider</th><th>Amount</th><th>Credits</th><th>Status</th><th>Created</th></tr>
            </thead>
            <tbody>
              {orders.map((o) => (
                <tr key={o.id}>
                  <td style={{ fontSize: 12 }}>{o.id.slice(0, 12)}…</td>
                  <td style={{ fontSize: 12 }}>{o.userId.slice(0, 12)}…</td>
                  <td>{o.kind}</td>
                  <td>{o.provider}</td>
                  <td>${o.amountUsd.toFixed(2)}</td>
                  <td>{o.credits}</td>
                  <td>{o.status}</td>
                  <td style={{ fontSize: 12 }}>{new Date(o.createdAt).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {tab === "images" && (
          <>
          {Math.ceil(imagesTotal / imagesPageSize) > 1 && (
            <div className="row" style={{ gap: 8, marginTop: 12, alignItems: "center" }}>
              <button
                className="btn btn-ghost btn-sm"
                disabled={imagesPage <= 1}
                style={{ opacity: imagesPage <= 1 ? 0.5 : 1 }}
                onClick={() => setImagesPage((p) => Math.max(1, p - 1))}
              >
                ‹ Newer
              </button>
              <button
                className="btn btn-ghost btn-sm"
                disabled={imagesPage >= Math.ceil(imagesTotal / imagesPageSize)}
                style={{ opacity: imagesPage >= Math.ceil(imagesTotal / imagesPageSize) ? 0.5 : 1 }}
                onClick={() => setImagesPage((p) => p + 1)}
              >
                Older ›
              </button>
              <span style={{ fontSize: 12, color: "#7c829a" }}>
                page {imagesPage} of {Math.ceil(imagesTotal / imagesPageSize)} · {imagesTotal} images
              </span>
            </div>
          )}
          <table className="ledger" style={{ width: "100%", marginTop: 16 }}>
            <thead>
              <tr><th></th><th>Image</th><th>User</th><th>Model</th><th>Prompt</th><th>Created</th><th></th></tr>
            </thead>
            <tbody>
              {images.map((img) => (
                <tr key={img.id}>
                  <td>
                    {/* Video outputs are in the same table, but a 56px <img>
                        of an MP4 renders nothing while downloading the whole
                        object — 50 rows a page, up to 100 MB each. Inline
                        preview only for images; a video is an explicit open
                        (the route refuses an automatic video stream). */}
                    {getModel(img.model)?.mediaType === "video" ? (
                      <a
                        href={`/api/admin/images/${img.id}?full=1`}
                        target="_blank"
                        rel="noreferrer"
                        style={{ fontSize: 12 }}
                        title="Open the video output"
                      >
                        video ↗
                      </a>
                    ) : (
                      <img
                        src={`/api/admin/images/${img.id}`}
                        alt=""
                        width={56}
                        height={56}
                        loading="lazy"
                        style={{ objectFit: "cover", borderRadius: 6, display: "block" }}
                      />
                    )}
                  </td>
                  <td style={{ fontSize: 12 }}>{img.id.slice(0, 10)}…</td>
                  <td style={{ fontSize: 12 }}>{img.userId.slice(0, 12)}…</td>
                  <td>{img.model}</td>
                  <td style={{ maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{img.prompt}</td>
                  <td style={{ fontSize: 12 }}>{new Date(img.createdAt).toLocaleString()}</td>
                  <td><button className="btn btn-danger btn-sm" onClick={() => deleteImage(img)}>Delete</button></td>
                </tr>
              ))}
            </tbody>
          </table>
          </>
        )}
        {tab === "feedback" && (
          <div style={{ marginTop: 16 }}>
            {!mail.deliverable && (
              // Without SMTP_URL the app prints notifications to its own log
              // instead of sending them. An operator who assumes mail is flowing
              // would never open this tab and would miss every message.
              <div className="form-error" style={{ marginBottom: 12 }}>
                No notification channel is configured: <code>SMTP_URL</code> is unset, so feedback mail is only written
                to the server log.
                {notify.webhook
                  ? " The webhook channel is set, so messages are still pushed."
                  : " Set SMTP_URL + EMAIL_FROM (docs/deploy.md) and run npx tsx scripts/verify-mail.ts, or point FEEDBACK_WEBHOOK_URL at a Feishu/WeCom/DingTalk group bot."}{" "}
                Messages below are complete either way.
              </div>
            )}
            {mail.deliverable && mail.lastAttempt && !mail.lastAttempt.ok && (
              // Configured is not the same as working: a rejected password or an
              // unverified sender domain passes the configuration check and then
              // fails silently, which looks exactly like "nobody wrote in".
              <div className="form-error" style={{ marginBottom: 12 }}>
                The last outgoing mail failed: {mail.lastAttempt.error ?? "unknown error"}
                {" — "}check <code>SMTP_URL</code> / <code>EMAIL_FROM</code>, then run{" "}
                <code>npx tsx scripts/verify-mail.ts</code> on the host (it explains the reason).
              </div>
            )}
            {mail.deliverable && mail.lastAttempt?.ok && (
              <p style={{ fontSize: 12, color: "#7c829a", marginBottom: 10 }}>
                Last outgoing mail accepted {new Date(mail.lastAttempt.at).toLocaleString()}
                {mail.lastAttempt.response ? ` — ${mail.lastAttempt.response}` : ""}
              </p>
            )}
            <div className="row" style={{ marginBottom: 10 }}>
              <label style={{ fontSize: 13, color: "#7c829a" }}>
                <input
                  type="checkbox"
                  checked={showHandled}
                  onChange={(e) => {
                    setShowHandled(e.target.checked);
                    // A filter change makes the old offset meaningless.
                    setFeedbackPage(1);
                  }}
                />{" "}
                show handled
              </label>
              <span style={{ marginLeft: "auto", fontSize: 13, color: "#7c829a" }}>
                {feedback.length === 0 ? "0" : `${feedbackFirst}–${feedbackLast}`} of {feedbackTotal}
                {" · "}
                {unhandled} unhandled
              </span>
            </div>
            {feedbackPages > 1 && (
              // Reachable pagination, not decoration: without it the 51st
              // newest message is invisible, and "60 unhandled" in the badge
              // matches only 50 visible rows.
              <div className="row" style={{ gap: 8, marginBottom: 10, alignItems: "center" }}>
                <button
                  className="btn btn-ghost btn-sm"
                  disabled={feedbackPage <= 1}
                  style={{ opacity: feedbackPage <= 1 ? 0.5 : 1 }}
                  onClick={() => setFeedbackPage((p) => Math.max(1, p - 1))}
                >
                  ‹ Newer
                </button>
                <button
                  className="btn btn-ghost btn-sm"
                  disabled={feedbackPage >= feedbackPages}
                  style={{ opacity: feedbackPage >= feedbackPages ? 0.5 : 1 }}
                  onClick={() => setFeedbackPage((p) => Math.min(feedbackPages, p + 1))}
                >
                  Older ›
                </button>
                <span style={{ fontSize: 12, color: "#7c829a" }}>
                  page {feedbackPage} of {feedbackPages} · {feedbackPageSize} per page, nothing deleted
                </span>
              </div>
            )}
            {feedback.length === 0 && <p style={{ color: "#7c829a", fontSize: 13 }}>Nothing here yet.</p>}
            {feedback.map((f) => (
              <div key={f.id} className="card" style={{ padding: 14, marginBottom: 10 }}>
                <div className="row" style={{ gap: 8, flexWrap: "wrap", fontSize: 12, color: "#7c829a" }}>
                  <span className="chip" style={{ cursor: "default" }}>{f.category}</span>
                  <b style={{ color: "var(--ink, #111)" }}>{f.email}</b>
                  {!f.userId && <span>(not signed in)</span>}
                  {f.plan && <span>plan: {f.plan}</span>}
                  {f.page && <span>from: {f.page}</span>}
                  {f.locale && <span>{f.locale}</span>}
                  <span style={{ marginLeft: "auto" }} title={f.id}>
                    #{f.id.slice(-8)} · {new Date(f.createdAt).toLocaleString()}
                  </span>
                  {f.status === "done" && <span style={{ color: "#2f9e44" }}>handled</span>}
                </div>
                <p style={{ whiteSpace: "pre-wrap", margin: "10px 0 10px", fontSize: 13.5, lineHeight: 1.6 }}>{f.message}</p>
                <div className="row" style={{ gap: 8 }}>
                  <a className="btn btn-ghost btn-sm" href={`mailto:${encodeURIComponent(f.email)}?subject=${encodeURIComponent(`Re: [PixelDuo] ${f.category}`)}`}>
                    Reply by email
                  </a>
                  {f.status === "new" ? (
                    <button className="btn btn-ghost btn-sm" onClick={() => markHandled(f, "done")}>Mark handled</button>
                  ) : (
                    <button className="btn btn-ghost btn-sm" onClick={() => markHandled(f, "new")}>Reopen</button>
                  )}
                  {f.userAgent && (
                    <span style={{ fontSize: 11, color: "#aab", marginLeft: "auto", maxWidth: 320, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={f.userAgent}>
                      {f.userAgent}
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
