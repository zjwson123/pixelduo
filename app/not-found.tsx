"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

export default function NotFound() {
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
        <h1 style={{ marginTop: 18, fontSize: 56, marginBottom: 0 }}>404</h1>
        <p className="sub" style={{ fontSize: 16 }}>
          {zh ? "这个页面不存在或已被移动。" : "This page doesn't exist or has moved."}
        </p>
        <div style={{ display: "flex", gap: 10, marginTop: 18 }}>
          <Link className="btn btn-dark" href="/">{zh ? "返回首页" : "Back to home"}</Link>
          <Link className="btn btn-ghost" href="/studio">{zh ? "进入工作台" : "Open the workbench"}</Link>
        </div>
      </div>
    </div>
  );
}
