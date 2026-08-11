"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

export default function ErrorPage() {
  const [zh, setZh] = useState(false);
  useEffect(() => {
    setZh(localStorage.getItem("pd-lang") === "zh");
  }, []);
  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <div className="row">
          <span className="logo-mark"><i></i><i></i></span>
          <span style={{ fontWeight: 800 }}>PixelDuo</span>
        </div>
        <h1 style={{ marginTop: 18 }}>{zh ? "出了点问题" : "Something went wrong"}</h1>
        <p className="sub">{zh ? "请稍后重试；如果持续出现，联系 support@pixelduo.ai。" : "Please try again shortly. If this keeps happening, contact support@pixelduo.ai."}</p>
        <div style={{ display: "flex", gap: 10, marginTop: 18 }}>
          <button className="btn btn-dark" onClick={() => window.location.reload()}>{zh ? "重试" : "Retry"}</button>
          <Link className="btn btn-ghost" href="/">{zh ? "返回首页" : "Back to home"}</Link>
        </div>
      </div>
    </div>
  );
}
