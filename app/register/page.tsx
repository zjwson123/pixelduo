"use client";

import { useState } from "react";
import { signIn } from "next-auth/react";
import { useRouter } from "next/navigation";
import Link from "next/link";

export default function RegisterPage() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    const res = await fetch("/api/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, email, password }),
    });
    const data = await res.json();
    if (!data.ok) {
      setError(
        data.error === "email-already-registered"
          ? "This email is already registered."
          : data.error === "rate-limited"
            ? "Too many attempts — please try again later."
            : "Registration failed.",
      );
      setBusy(false);
      return;
    }
    if (data.pendingVerification) {
      setSent(true);
      setBusy(false);
      return;
    }
    await signIn("credentials", { email, password, redirect: false });
    router.push("/studio");
    router.refresh();
  };

  if (sent) {
    return (
      <div className="auth-wrap">
        <div className="auth-card">
          <div className="row">
            <span className="logo-mark"><i></i><i></i></span>
            <span style={{ fontWeight: 800 }}>PixelDuo</span>
          </div>
          <h1 style={{ marginTop: 18 }}>Check your inbox</h1>
          <p className="sub">
            We sent a verification link to <b>{email}</b>. Click it to activate your 30 free credits, then sign in.
          </p>
          <div className="auth-foot">
            <Link className="link" href="/login">Back to sign in</Link>
          </div>
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
        <h1 style={{ marginTop: 18 }}>Create account</h1>
        <p className="sub">Free beta · 30 credits on signup · invite only.</p>
        {error && <div className="form-error">{error}</div>}
        <div className="field">
          <label htmlFor="name">Name</label>
          <input id="name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Pixel Maker" />
        </div>
        <div className="field">
          <label htmlFor="email">Email</label>
          <input id="email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
        </div>
        <div className="field">
          <label htmlFor="password">Password (min 8 chars)</label>
          <input id="password" type="password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" />
        </div>
        <button type="submit" className="btn btn-dark btn-block" disabled={busy} style={{ marginTop: 6 }}>
          {busy ? "Creating…" : "Create account"}
        </button>
        <div className="auth-foot">
          Already have an account? <Link className="link" href="/login">Sign in</Link>
        </div>
        <div className="auth-foot" style={{ marginTop: 10, fontSize: 12 }}>
          <Link className="link" href="/terms">Terms</Link> · <Link className="link" href="/privacy">Privacy</Link>
        </div>
      </form>
    </div>
  );
}
