"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

export default function VerifyEmailPage() {
  const [token, setToken] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [wrongPassword, setWrongPassword] = useState(false);
  const [done, setDone] = useState(false);
  const [missingToken, setMissingToken] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const t = params.get("token");
    if (!t) setMissingToken(true);
    else setToken(t);
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token) return;
    setBusy(true);
    setError("");
    setWrongPassword(false);
    try {
      const res = await fetch("/api/auth/verify-email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password }),
      });
      const data = await res.json();
      if (data.ok) {
        setDone(true);
        return;
      }
      if (data.error === "invalid-password") {
        setWrongPassword(true);
        return;
      }
      setError(
        data.error === "invalid-token"
          ? "This link is invalid or has expired."
          : "Verification failed. Please try again.",
      );
    } catch {
      setError("Verification failed. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <div className="auth-wrap">
        <div className="auth-card">
          <div className="row">
            <span className="logo-mark"><i></i><i></i></span>
            <span style={{ fontWeight: 800 }}>PixelDuo</span>
          </div>
          <h1 style={{ marginTop: 18 }}>Email verified 🎉</h1>
          <p className="sub">Your 30 free credits are active. You can sign in now.</p>
          <Link className="btn btn-dark btn-block" href="/login" style={{ marginTop: 16, textAlign: "center" }}>
            Go to sign in
          </Link>
        </div>
      </div>
    );
  }

  if (missingToken || error) {
    return (
      <div className="auth-wrap">
        <div className="auth-card">
          <div className="row">
            <span className="logo-mark"><i></i><i></i></span>
            <span style={{ fontWeight: 800 }}>PixelDuo</span>
          </div>
          <h1 style={{ marginTop: 18 }}>Verification failed</h1>
          <p className="sub">{missingToken ? "Missing verification token." : error}</p>
          <Link className="btn btn-dark btn-block" href="/login" style={{ marginTop: 16, textAlign: "center" }}>
            Back to sign in
          </Link>
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
        <h1 style={{ marginTop: 18 }}>Activate your account</h1>
        <p className="sub">
          Enter the password you chose at sign-up to finish verifying your email and unlock your 30 free credits.
        </p>
        {wrongPassword && (
          <div className="form-error">
            That password doesn&apos;t match this account. If you didn&apos;t create this account,{" "}
            <Link className="link" href="/forgot-password">
              reset the password
            </Link>{" "}
            — that removes the one that was set and lets you in.
          </div>
        )}
        <div className="field">
          <label htmlFor="verify-pw">Password</label>
          <input
            id="verify-pw"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </div>
        <button className="btn btn-dark btn-block" type="submit" disabled={busy || !token} style={{ marginTop: 16 }}>
          {busy ? "Verifying…" : "Verify email"}
        </button>
        <p className="sub" style={{ marginTop: 12 }}>
          Forgot it?{" "}
          <Link className="link" href="/forgot-password">
            Reset your password
          </Link>
        </p>
      </form>
    </div>
  );
}
