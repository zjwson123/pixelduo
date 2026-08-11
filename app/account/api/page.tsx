"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

interface ApiKeyRow {
  id: string;
  name: string;
  prefix: string;
  revokedAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
}

export default function ApiKeysPage() {
  const [keys, setKeys] = useState<ApiKeyRow[]>([]);
  const [name, setName] = useState("");
  const [created, setCreated] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/account/keys");
      const data = await res.json();
      if (data.ok) setKeys(data.keys);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/account/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name || "default" }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error ?? "create failed");
      setCreated(data.key);
      setName("");
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "create failed");
    }
    setBusy(false);
  };

  const revoke = async (k: ApiKeyRow) => {
    if (!confirm(`Revoke API key "${k.name}"? Existing requests will stop working.`)) return;
    setError("");
    await fetch(`/api/account/keys/${k.id}/revoke`, { method: "POST" });
    refresh();
  };

  const copy = async () => {
    if (!created) return;
    await navigator.clipboard.writeText(created);
  };

  return (
    <div className="auth-wrap">
      <div className="auth-card" style={{ maxWidth: 720 }}>
        <div className="row">
          <span className="logo-mark"><i></i><i></i></span>
          <h1 style={{ fontWeight: 800, fontSize: 22, margin: 0 }}>API Keys</h1>
        </div>
        <p className="sub">
          Programmatic image generation via <code>POST /api/v1/images/generations</code> — billed per image from
          your credits. See <code>docs/api.md</code> for usage examples.
        </p>

        {error && <div className="form-error">{error}</div>}

        {created && (
          <div className="api-key-banner" style={{ margin: "14px 0", padding: 12, borderRadius: 10, border: "1px solid rgba(255,193,7,0.5)", background: "rgba(255,193,7,0.1)" }}>
            <b>Copy your key now — it won&apos;t be shown again:</b>
            <div style={{ display: "flex", gap: 8, marginTop: 8, alignItems: "center" }}>
              <code style={{ flex: 1, wordBreak: "break-all", background: "rgba(0,0,0,0.05)", padding: "8px 10px", borderRadius: 8 }}>{created}</code>
              <button className="btn btn-dark btn-sm" onClick={copy}>Copy</button>
            </div>
            <button className="btn btn-ghost btn-sm" style={{ marginTop: 8 }} onClick={() => setCreated(null)}>Done</button>
          </div>
        )}

        <form onSubmit={create} style={{ display: "flex", gap: 8, marginTop: 14 }}>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Key name (e.g. production)"
            style={{ flex: 1, padding: "10px 12px", borderRadius: 10, border: "1px solid rgba(0,0,0,0.15)" }}
          />
          <button type="submit" className="btn btn-dark" disabled={busy}>{busy ? "Creating…" : "Create key"}</button>
        </form>

        <table className="ledger" style={{ width: "100%", marginTop: 18 }}>
          <thead>
            <tr><th>Name</th><th>Key</th><th>Last used</th><th>Status</th><th></th></tr>
          </thead>
          <tbody>
            {keys.map((k) => (
              <tr key={k.id}>
                <td>{k.name}</td>
                <td><code>{k.prefix}…</code></td>
                <td style={{ fontSize: 12 }}>{k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleString() : "never"}</td>
                <td>{k.revokedAt ? "revoked" : "active"}</td>
                <td>
                  {!k.revokedAt && (
                    <button className="btn btn-danger btn-sm" onClick={() => revoke(k)}>Revoke</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="auth-foot">
          <Link className="link" href="/studio">Back to workbench</Link>
        </div>
      </div>
    </div>
  );
}
