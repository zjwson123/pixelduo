"use client";

import { useState } from "react";
import Link from "next/link";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    const res = await fetch("/api/auth/forgot-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });
    const data = await res.json();
    setBusy(false);
    if (!data.ok) {
      setError("Something went wrong. Please try again.");
      return;
    }
    setSent(true);
  };

  return (
    <div className="auth-wrap">
      <form className="auth-card" onSubmit={submit}>
        <div className="row">
          <span className="logo-mark"><i></i><i></i></span>
          <span style={{ fontWeight: 800 }}>PixelDuo</span>
        </div>
        <h1 style={{ marginTop: 18 }}>Reset password</h1>
        <p className="sub">Enter your email and we&apos;ll send a reset link (valid for 1 hour).</p>
        {sent ? (
          <div>
            <p style={{ margin: "16px 0" }}>If an account exists for <b>{email}</b>, a reset link is on its way.</p>
            <Link className="link" href="/login">Back to sign in</Link>
          </div>
        ) : (
          <>
            {error && <div className="form-error">{error}</div>}
            <div className="field">
              <label htmlFor="email">Email</label>
              <input id="email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
            </div>
            <button type="submit" className="btn btn-dark btn-block" disabled={busy} style={{ marginTop: 6 }}>
              {busy ? "Sending…" : "Send reset link"}
            </button>
          </>
        )}
        <div className="auth-foot">
          <Link className="link" href="/login">Back to sign in</Link>
        </div>
      </form>
    </div>
  );
}
