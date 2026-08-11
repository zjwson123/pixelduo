"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

export default function ResetPasswordPage() {
  const router = useRouter();
  const [token, setToken] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setToken(params.get("token"));
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token) return;
    setBusy(true);
    setError("");
    const res = await fetch("/api/auth/reset-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, password }),
    });
    const data = await res.json();
    setBusy(false);
    if (!data.ok) {
      setError(data.error === "invalid-token" ? "This link is invalid or has expired." : "Something went wrong. Please try again.");
      return;
    }
    setDone(true);
  };

  if (done) {
    return (
      <div className="auth-wrap">
        <div className="auth-card">
          <h1 style={{ marginTop: 18 }}>Password updated</h1>
          <p className="sub">You can now sign in with your new password.</p>
          <button className="btn btn-dark btn-block" onClick={() => router.push("/login")} style={{ marginTop: 16 }}>
            Go to sign in
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="auth-wrap">
      <form className="auth-card" onSubmit={submit}>
        <div className="row">
          <span className="logo-mark"><i></i><i></i></span>
          <span style={{ fontWeight: 800 }}>PixelDuo</span>
        </div>
        <h1 style={{ marginTop: 18 }}>Choose a new password</h1>
        <p className="sub">Minimum 8 characters.</p>
        {error && <div className="form-error">{error}</div>}
        <div className="field">
          <label htmlFor="password">New password</label>
          <input id="password" type="password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" />
        </div>
        <button type="submit" className="btn btn-dark btn-block" disabled={busy || !token} style={{ marginTop: 6 }}>
          {busy ? "Saving…" : "Update password"}
        </button>
        <div className="auth-foot">
          <Link className="link" href="/login">Back to sign in</Link>
        </div>
      </form>
    </div>
  );
}
