// Cookie names for next-auth's state-bearing cookies.
//
// next-auth names them `__Secure-*` whenever NEXTAUTH_URL is https. The
// `__Secure-` prefix only requires the Secure attribute; it still permits a
// Domain attribute, so a hostile sibling subdomain (evil.example.com when the
// app is app.example.com) can plant its own
// `__Secure-next-auth.session-token` — or an OAuth `state` / PKCE verifier
// pair it copied from its own sign-in — for the parent domain. The browser
// stores that alongside the host-only legitimate cookie and sends both; the
// later-created one wins in the server's parser, so the victim either operates
// inside the attacker's account (login CSRF: prompts, uploads and purchases
// they make belong to the attacker) or completes the attacker's OAuth callback
// (session fixation).
//
// `__Host-` forbids Domain by construction, so a planted parent-domain cookie
// is rejected by the browser. It requires Secure + Path=/ and no Domain —
// exactly what a production deployment behind TLS serves. Development over
// http://localhost keeps next-auth's unprefixed names.
//
// The names live in one module because proxy.ts keys its per-credential rate
// buckets on the session cookie; it must recognise the same spelling the auth
// routes mint.
export function secureAuthCookies(): boolean {
  // Parse, don't prefix-match. The boot gate (instrumentation.ts) validates
  // NEXTAUTH_URL through `new URL()`, which normalises the scheme — so
  // "HTTPS://pixelduo.ai" and "https:/pixelduo.ai" both boot as https
  // deployments. A raw startsWith("https://") is false for both spellings, and
  // the cookie layer then minted UNPREFIXED, NON-Secure session/OAuth cookies
  // on a deployment that looked healthy: a sibling subdomain could plant
  // `next-auth.session-token` for the parent domain (the pass-53 fixation this
  // prefix exists to stop), and the session cookie travelled in cleartext
  // before HSTS was learned. One predicate, the same one the gate uses.
  const raw = (process.env.NEXTAUTH_URL ?? "").trim();
  if (!raw) return false;
  try {
    return new URL(raw).protocol === "https:";
  } catch {
    return false;
  }
}

export function authCookiePrefix(): string {
  return secureAuthCookies() ? "__Host-" : "";
}

export interface AuthCookieOption {
  name: string;
  options: {
    httpOnly: boolean;
    sameSite: "lax";
    path: string;
    secure: boolean;
    maxAge?: number;
  };
}

// next-auth's `cookies` option. CSRF is deliberately absent: its default is
// already `__Host-` under https, and it is a signed double-submit cookie that
// cannot be planted usefully.
export function authCookies(): Record<
  "sessionToken" | "callbackUrl" | "pkceCodeVerifier" | "state" | "nonce",
  AuthCookieOption
> {
  const prefix = authCookiePrefix();
  const secure = secureAuthCookies();
  const base = { httpOnly: true, sameSite: "lax" as const, path: "/", secure };
  return {
    sessionToken: { name: `${prefix}next-auth.session-token`, options: { ...base } },
    callbackUrl: { name: `${prefix}next-auth.callback-url`, options: { ...base } },
    pkceCodeVerifier: {
      name: `${prefix}next-auth.pkce.code_verifier`,
      options: { ...base, maxAge: 60 * 15 },
    },
    state: { name: `${prefix}next-auth.state`, options: { ...base, maxAge: 60 * 15 } },
    nonce: { name: `${prefix}next-auth.nonce`, options: { ...base } },
  };
}

// Every session-cookie spelling this app can encounter: the current one, the
// `__Secure-` one every deployment used before this change (so a rolling
// upgrade still caps an old cookie's bucket instead of dropping every signed-in
// user onto the shared address bucket), and the development name.
export function sessionCookieNames(): string[] {
  return [
    "__Host-next-auth.session-token",
    "__Secure-next-auth.session-token",
    "next-auth.session-token",
  ];
}
