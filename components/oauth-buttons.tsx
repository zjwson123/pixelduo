"use client";

import { useEffect, useState } from "react";
import { signIn } from "next-auth/react";

interface ProviderInfo {
  id: string;
  name: string;
  type: string;
}

// Renders OAuth provider buttons (Google/GitHub) only when they are configured
// via env (GOOGLE_CLIENT_ID / GITHUB_CLIENT_ID …).
export function OAuthButtons() {
  const [providers, setProviders] = useState<ProviderInfo[]>([]);

  useEffect(() => {
    fetch("/api/auth/providers")
      .then((r) => r.json())
      .then((data) => {
        const list = Object.values(data as Record<string, ProviderInfo>).filter((p) => p.type === "oauth");
        setProviders(list);
      })
      .catch(() => undefined);
  }, []);

  if (providers.length === 0) return null;
  return (
    <div style={{ marginTop: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "12px 0", color: "#7c829a", fontSize: 12 }}>
        <span style={{ flex: 1, height: 1, background: "rgba(0,0,0,0.14)" }} />
        or continue with
        <span style={{ flex: 1, height: 1, background: "rgba(0,0,0,0.14)" }} />
      </div>
      {providers.map((p) => (
        <button
          key={p.id}
          type="button"
          className="btn btn-ghost btn-block"
          onClick={() => signIn(p.id, { callbackUrl: "/studio" })}
          style={{ marginTop: 8 }}
        >
          Continue with {p.name}
        </button>
      ))}
    </div>
  );
}
