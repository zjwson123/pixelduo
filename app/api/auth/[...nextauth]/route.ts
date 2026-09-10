import NextAuth from "next-auth";
import { authOptions } from "@/lib/auth";
import { enforceRateLimit } from "@/lib/api";

const handler = NextAuth(authOptions);

// Per-IP cap on ALL NextAuth endpoints (credentials login, CSRF/session
// fetches, OAuth hops). The per-account lockout (lib/login-guard.ts) stops
// targeted brute force, but without this one IP can password-spray thousands
// of distinct emails forever — each attempt also burns a bcrypt compare, a
// cheap CPU-DoS amplification. 300/min is high enough for shared-NAT offices
// and the e2e suite, low enough to bound the bcrypt burn.
async function limited(req: Request, ctx: Parameters<typeof handler>[1]) {
  const res = await enforceRateLimit(req, "auth-endpoint", 300, 60_000);
  if (res) return res;
  return handler(req, ctx);
}

export { limited as GET, limited as POST };
