"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

interface Me {
  email: string;
  totpEnabled: boolean;
}

interface Setup {
  secret: string;
  otpauthUrl: string;
  qrDataUrl: string;
}

export default function SecurityPage() {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [setup, setSetup] = useState<Setup | null>(null);
  const [code, setCode] = useState("");
  const [backupCodes, setBackupCodes] = useState<string[] | null>(null);
  const [password, setPassword] = useState("");
  const [setupPassword, setSetupPassword] = useState("");
  const [signedOut, setSignedOut] = useState(false);
  // The enrollment was already complete when this page's confirm arrived (a
  // concurrent tab, or an earlier confirmation whose response was lost) — see
  // confirm(). The route answers `alreadyEnabled` WITHOUT backup codes, so the
  // page needs its own state instead of falling through to the enable form.
  const [alreadyEnabled, setAlreadyEnabled] = useState(false);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/me");
      if (res.status === 403) {
        router.push("/login?2fa=1");
        return;
      }
      const data = await res.json();
      if (data.ok) setMe(data.user);
    } catch {
      // ignore
    }
  }, [router]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const enable = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/2fa/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: setupPassword }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error === "invalid-password" ? "Wrong password." : data.error ?? "setup failed");
      if (data.alreadyEnabled) {
        setInfo("Two-factor authentication is already enabled.");
        refresh();
      } else {
        setSetup({ secret: data.secret, otpauthUrl: data.otpauthUrl, qrDataUrl: data.qrDataUrl });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Setup failed.");
    }
    setBusy(false);
  };

  const confirm = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    const res = await fetch("/api/2fa/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: code, password: setupPassword }),
    });
    const data = await res.json();
    setBusy(false);
    if (!data.ok) {
      setError(
        data.error === "invalid-code"
          ? "Invalid code — try again."
          : data.error === "invalid-password"
            ? "Wrong password — start over."
            : "Confirmation failed.",
      );
      if (data.error === "invalid-password") {
        setSetup(null);
        setSetupPassword("");
        setCode("");
      }
      return;
    }
    // The enrollment CAS was lost: another tab (or an earlier confirmation
    // whose response never arrived) already enabled it. This answer carries NO
    // backup codes, and the codes are returned exactly once — so the page used
    // to set `backupCodes` to undefined, drop `setup`, and fall through to the
    // "Confirm your password to start" form: the user was told nothing, believed
    // enrollment had failed, and never learned that their recovery codes had
    // been issued (and lost). Say what happened instead.
    if (data.alreadyEnabled) {
      setSetup(null);
      setCode("");
      setAlreadyEnabled(true);
      setSignedOut(true); // enabling bumped the session version
      return;
    }
    setBackupCodes(data.backupCodes);
    setSetup(null);
    setCode("");
    setSignedOut(true); // enabling 2FA signed out every session (incl. this one)
  };

  const disable = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    const res = await fetch("/api/2fa/disable", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password, token: code }),
    });
    const data = await res.json();
    setBusy(false);
    if (!data.ok) {
      setError(data.error === "invalid-password" ? "Wrong password." : data.error === "invalid-code" ? "Invalid code." : "Disable failed.");
      return;
    }
    setPassword("");
    setCode("");
    setInfo("Two-factor authentication disabled.");
    refresh();
  };

  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <div className="row">
          <span className="logo-mark"><i></i><i></i></span>
          <span style={{ fontWeight: 800 }}>PixelDuo</span>
        </div>
        <h1 style={{ marginTop: 18 }}>Security</h1>
        <p className="sub">{me?.email ?? "…"} · Two-factor authentication (TOTP)</p>

        {error && <div className="form-error">{error}</div>}
        {info && <p style={{ color: "#2f9e44", margin: "10px 0" }}>{info}</p>}

        {backupCodes ? (
          <div>
            <h2 style={{ fontSize: 17, marginTop: 18 }}>Save your backup codes</h2>
            <p className="sub">Each code works exactly once. Store them somewhere safe — they&apos;re your only way back in if you lose your authenticator.</p>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, margin: "14px 0" }}>
              {backupCodes.map((c) => (
                <code key={c} style={{ background: "rgba(0,0,0,0.05)", padding: "8px 10px", borderRadius: 8, fontFamily: "monospace" }}>{c}</code>
              ))}
            </div>
            {signedOut && (
              <p className="sub" style={{ color: "#e8590c" }}>
                2FA is now active and all other sessions were signed out — including this one.
                Sign in again with your password and a code from your authenticator.
              </p>
            )}
            <Link className="btn btn-dark btn-block" href="/login" style={{ display: "block", textAlign: "center", padding: "10px 0", marginTop: 10 }}>
              Go to sign-in
            </Link>
          </div>
        ) : alreadyEnabled ? (
          <div>
            <h2 style={{ fontSize: 17, marginTop: 18 }}>Two-factor authentication is already enabled</h2>
            <p className="sub">
              It was enabled by another tab, or by an earlier confirmation whose response did not reach this page — the
              account is protected and your authenticator app works now.
            </p>
            <p className="sub" style={{ color: "#e8590c" }}>
              The ten backup codes are shown only once, when 2FA is enabled, and that response was already spent. If you
              did not save them, ask the operator to reset 2FA for this account before you lose the authenticator.
            </p>
            <p className="sub">
              Enabling 2FA signed out every session, including this one — sign in again with your password and a code
              from your authenticator.
            </p>
            <Link className="btn btn-dark btn-block" href="/login" style={{ display: "block", textAlign: "center", padding: "10px 0", marginTop: 10 }}>
              Go to sign-in
            </Link>
          </div>
        ) : me?.totpEnabled && !setup ? (
          <form onSubmit={disable} style={{ marginTop: 14 }}>
            <div className="field">
              <label htmlFor="pw">Password</label>
              <input id="pw" type="password" required value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" />
            </div>
            <div className="field">
              <label htmlFor="code">Current 6-digit code</label>
              <input id="code" value={code} onChange={(e) => setCode(e.target.value)} placeholder="••••••" required />
            </div>
            <button type="submit" className="btn btn-danger btn-block" disabled={busy} style={{ marginTop: 6 }}>
              {busy ? "Disabling…" : "Disable 2FA"}
            </button>
          </form>
        ) : setup ? (
          <form onSubmit={confirm} style={{ marginTop: 14 }}>
            <h2 style={{ fontSize: 17 }}>Scan with your authenticator app</h2>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={setup.qrDataUrl} alt="TOTP QR code" style={{ width: 180, height: 180, margin: "12px 0", imageRendering: "pixelated" }} />
            <p className="sub" style={{ wordBreak: "break-all" }}>Secret: <code>{setup.secret}</code></p>
            <div className="field">
              <label htmlFor="code">6-digit code from the app</label>
              <input id="code" value={code} onChange={(e) => setCode(e.target.value)} placeholder="••••••" required />
            </div>
            <button type="submit" className="btn btn-dark btn-block" disabled={busy} style={{ marginTop: 6 }}>
              {busy ? "Confirming…" : "Confirm & enable"}
            </button>
          </form>
        ) : (
          <form onSubmit={enable} style={{ marginTop: 14 }}>
            <div className="field">
              <label htmlFor="setup-pw">Confirm your password to start</label>
              <input
                id="setup-pw"
                type="password"
                required
                value={setupPassword}
                onChange={(e) => setSetupPassword(e.target.value)}
                placeholder="••••••••"
                autoComplete="current-password"
              />
            </div>
            <button type="submit" className="btn btn-dark btn-block" disabled={busy}>
              {busy ? "Preparing…" : "Enable 2FA"}
            </button>
          </form>
        )}

        <div className="auth-foot">
          <Link className="link" href="/studio">Back to workbench</Link>
        </div>
      </div>
    </div>
  );
}
