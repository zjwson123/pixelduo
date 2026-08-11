"use client";

import { useState } from "react";
import { signIn } from "next-auth/react";
import { useRouter } from "next/navigation";
import Link from "next/link";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    const res = await signIn("credentials", { email, password, redirect: false });
    setBusy(false);
    if (res?.error) {
      setError("Invalid email or password.");
      return;
    }
    router.push("/studio");
    router.refresh();
  };

  return (
    <div className="auth-wrap">
      <form className="auth-card" onSubmit={submit}>
        <div className="row">
          <span className="logo-mark"><i></i><i></i></span>
          <span style={{ fontWeight: 800 }}>PixelDuo</span>
        </div>
        <h1 style={{ marginTop: 18 }}>Sign in</h1>
        <p className="sub">Welcome back to the workbench.</p>
        {error && <div className="form-error">{error}</div>}
        <div className="field">
          <label htmlFor="email">Email</label>
          <input id="email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
        </div>
        <div className="field">
          <label htmlFor="password">Password</label>
          <input id="password" type="password" required value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" />
        </div>
        <div className="auth-foot" style={{ marginTop: 2 }}>
          <Link className="link" href="/forgot-password">Forgot password?</Link>
        </div>
        <button type="submit" className="btn btn-dark btn-block" disabled={busy} style={{ marginTop: 6 }}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
        <div className="auth-foot">
          No account? <Link className="link" href="/register">Create one — 30 free credits</Link>
        </div>
      </form>
    </div>
  );
}
