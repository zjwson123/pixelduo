"use client";

import { useState } from "react";
import { signIn } from "next-auth/react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { OAuthButtons } from "@/components/oauth-buttons";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [backupMode, setBackupMode] = useState(false);
  const [step, setStep] = useState<"password" | "totp">("password");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submitPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    const res = await signIn("credentials", { email, password, redirect: false });
    setBusy(false);
    if (res?.error) {
      setError(
        res.error === "AccessDenied"
          ? "Two-factor authentication is enabled — sign in with your password."
          : "Invalid email or password.",
      );
      return;
    }
    const status = await fetch("/api/auth/2fa-status").then((r) => r.json());
    if (status.ok && status.needs2fa) {
      setStep("totp");
      return;
    }
    router.push("/studio");
    router.refresh();
  };

  const submitTotp = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    const res = await fetch("/api/auth/2fa-verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(backupMode ? { backupCode: code } : { token: code }),
    });
    const data = await res.json();
    if (!data.ok) {
      setBusy(false);
      setError(data.error === "invalid-code" ? "Invalid code." : "Verification failed.");
      return;
    }
    const s = await signIn("credentials", { email, password, preAuthToken: data.preAuthToken, redirect: false });
    setBusy(false);
    if (s?.error) {
      setError("Verification failed.");
      return;
    }
    router.push("/studio");
    router.refresh();
  };

  if (step === "totp") {
    return (
      <div className="auth-wrap">
        <form className="auth-card" onSubmit={submitTotp}>
          <div className="row">
            <span className="logo-mark"><i></i><i></i></span>
            <span style={{ fontWeight: 800 }}>PixelDuo</span>
          </div>
          <h1 style={{ marginTop: 18 }}>Two-factor authentication</h1>
          <p className="sub">Enter the 6-digit code from your authenticator app{backupMode ? " (backup code)" : ""}.</p>
          {error && <div className="form-error">{error}</div>}
          <div className="field">
            <label htmlFor="code">{backupMode ? "Backup code" : "6-digit code"}</label>
            <input
              id="code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder={backupMode ? "XXXXXXXXXXXXXXXXXXXX" : "••••••"}
              autoFocus
              required
            />
          </div>
          <button type="submit" className="btn btn-dark btn-block" disabled={busy} style={{ marginTop: 6 }}>
            {busy ? "Verifying…" : "Verify"}
          </button>
          <div className="auth-foot">
            <button type="button" className="link" style={{ background: "none", border: 0, cursor: "pointer" }} onClick={() => { setBackupMode(!backupMode); setCode(""); setError(""); }}>
              {backupMode ? "Use authenticator code instead" : "Use a backup code instead"}
            </button>
          </div>
        </form>
      </div>
    );
  }

  return (
    <div className="auth-wrap">
      <form className="auth-card" onSubmit={submitPassword}>
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
        <OAuthButtons />
        <div className="auth-foot">
          No account? <Link className="link" href="/register">Create one — 30 free credits</Link>
        </div>
        <div className="auth-foot" style={{ marginTop: 10, fontSize: 12 }}>
          <Link className="link" href="/terms">Terms</Link> · <Link className="link" href="/privacy">Privacy</Link>
        </div>
      </form>
    </div>
  );
}
