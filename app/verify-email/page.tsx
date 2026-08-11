"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

type Status = "checking" | "success" | "error";

export default function VerifyEmailPage() {
  const [status, setStatus] = useState<Status>("checking");
  const [message, setMessage] = useState("");

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const token = params.get("token");
    if (!token) {
      setStatus("error");
      setMessage("Missing verification token.");
      return;
    }
    fetch("/api/auth/verify-email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    })
      .then((r) => r.json())
      .then((data) => {
        if (data.ok) {
          setStatus("success");
        } else {
          setStatus("error");
          setMessage(data.error === "invalid-token" ? "This link is invalid or has expired." : "Verification failed. Please try again.");
        }
      })
      .catch(() => {
        setStatus("error");
        setMessage("Verification failed. Please try again.");
      });
  }, []);

  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <div className="row">
          <span className="logo-mark"><i></i><i></i></span>
          <span style={{ fontWeight: 800 }}>PixelDuo</span>
        </div>
        {status === "checking" && (
          <>
            <h1 style={{ marginTop: 18 }}>Verifying…</h1>
            <p className="sub">Confirming your email address.</p>
          </>
        )}
        {status === "success" && (
          <>
            <h1 style={{ marginTop: 18 }}>Email verified 🎉</h1>
            <p className="sub">Your 30 free credits are active. You can sign in now.</p>
            <Link className="btn btn-dark btn-block" href="/login" style={{ marginTop: 16, textAlign: "center" }}>
              Go to sign in
            </Link>
          </>
        )}
        {status === "error" && (
          <>
            <h1 style={{ marginTop: 18 }}>Verification failed</h1>
            <p className="sub">{message}</p>
            <Link className="link" href="/login" style={{ marginTop: 12, display: "inline-block" }}>
              Back to sign in
            </Link>
          </>
        )}
      </div>
    </div>
  );
}
