import type { NextAuthOptions } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import GoogleProvider from "next-auth/providers/google";
import GitHubProvider from "next-auth/providers/github";
import bcrypt from "bcryptjs";
import { randomBytes } from "crypto";
import { prisma } from "./prisma";
import { reserveLoginAttempt, clearLoginFailures } from "./login-guard";
import { verifyPreAuthToken } from "./twofa";
import { signupBonus } from "./ledger";

// Source address for the per-(email, IP) login cap. Behind Caddy the LAST
// X-Forwarded-For entry is the address the edge saw. The value is a hint only:
// spoofing it splits the per-pair counter, but the per-email cap still binds.
//
// X-Real-IP is NOT trusted here. Nothing in front of us is known to set it, so
// honouring it let a single source pick a fresh bucket per request by sending
// `X-Real-IP: <random>` with no XFF — defeating the pair cap entirely. This is
// the same reasoning (and the same TRUST_X_REAL_IP gate) as clientIp in
// lib/rate-limit.ts, which was fixed earlier while this copy was missed.
export function loginAttemptIp(headers: Record<string, unknown> | undefined): string | undefined {
  const raw = headers?.["x-forwarded-for"] ?? (process.env.TRUST_X_REAL_IP === "1" ? headers?.["x-real-ip"] : undefined);
  const value = Array.isArray(raw) ? raw[raw.length - 1] : raw;
  if (typeof value !== "string") return undefined;
  const parts = value.split(",").map((s) => s.trim()).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : undefined;
}

interface AuthUser {
  id: string;
  email: string;
  name: string | null;
  sessionVersion: number;
  totpPending?: boolean;
}

// Constant-work compare target for unknown emails: without it, "no such user"
// returns faster than "wrong password", leaking account existence by timing.
const DUMMY_HASH = bcrypt.hashSync(randomBytes(16).toString("hex"), 10);

export const authOptions: NextAuthOptions = {
  session: { strategy: "jwt" },
  pages: { signIn: "/login" },
  providers: [
    CredentialsProvider({
      name: "credentials",
      credentials: { email: {}, password: {} },
      async authorize(credentials, req) {
        if (!credentials?.email || !credentials?.password) return null;
        const email = credentials.email.toLowerCase().trim();
        const user = await prisma.user.findUnique({ where: { email } });
        if (!user) {
          await bcrypt.compare(credentials.password, DUMMY_HASH);
          return null;
        }
        const ip = loginAttemptIp(req?.headers);
        // Reserve before the compare (atomic check-and-increment) so a
        // concurrent burst cannot slip past the cap by all reading the same
        // pre-increment count.
        const attempt = await reserveLoginAttempt(email, ip);
        if (!attempt.allowed) return null;
        const ok = await bcrypt.compare(credentials.password, user.passwordHash);
        if (!ok) return null;
        // Correct password: refund this attempt from both counters.
        await clearLoginFailures(email, ip);
        if (user.totpEnabled) {
          const pre = (credentials as Record<string, string>).preAuthToken;
          // Second step: password + valid one-time 2FA ticket → real session.
          if (pre && (await verifyPreAuthToken(pre, email))) {
            return {
              id: user.id,
              email: user.email,
              name: user.name,
              sessionVersion: user.sessionVersion,
              totpPending: false,
            } as AuthUser;
          }
          // First step: password OK but 2FA not yet completed. This returns a
          // guarded partial session that can only call the 2FA endpoints.
          return {
            id: user.id,
            email: user.email,
            name: user.name,
            sessionVersion: user.sessionVersion,
            totpPending: true,
          } as AuthUser;
        }
        return {
          id: user.id,
          email: user.email,
          name: user.name,
          sessionVersion: user.sessionVersion,
          totpPending: false,
        } as AuthUser;
      },
    }),
    // OAuth providers activate only when credentials are configured.
    ...(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
      ? [
          GoogleProvider({
            clientId: process.env.GOOGLE_CLIENT_ID,
            clientSecret: process.env.GOOGLE_CLIENT_SECRET,
          }),
        ]
      : []),
    ...(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET
      ? [
          GitHubProvider({
            clientId: process.env.GITHUB_CLIENT_ID,
            clientSecret: process.env.GITHUB_CLIENT_SECRET,
          }),
        ]
      : []),
  ],
  callbacks: {
    // OAuth: find-or-create the local account (providers verify the email).
    // Users with 2FA enabled must keep using password login — otherwise OAuth
    // would silently bypass the second factor.
    async signIn({ user, account, profile }) {
      if (account?.type !== "oauth") return true;
      // Forward the provider's own email_verified claim so an explicitly
      // unverified address can never auto-verify a local account.
      const claim = (profile as { email_verified?: unknown } | undefined)?.email_verified;
      const dbUser = await ensureOAuthUser(
        user.email ?? "",
        user.name ?? "",
        typeof claim === "boolean" ? claim : null,
      );
      if (!dbUser) return false;
      if (dbUser.totpEnabled) return false;
      return true;
    },
    async jwt({ token, user, account }) {
      if (user) {
        if (account?.type === "oauth") {
          // OAuth first sign-in: map the provider profile to our account.
          const db = await prisma.user.findUnique({
            where: { email: (user.email ?? "").toLowerCase().trim() },
            select: { id: true, sessionVersion: true },
          });
          if (db) {
            token.uid = db.id;
            token.sv = db.sessionVersion;
            token.totpPending = false;
          }
        } else {
          token.uid = (user as AuthUser).id;
          token.sv = (user as AuthUser).sessionVersion ?? 0;
          token.totpPending = (user as AuthUser).totpPending ?? false;
        }
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        (session.user as { id?: string }).id = token.uid as string;
        (session.user as { sv?: number }).sv = token.sv as number;
        (session.user as { totpPending?: boolean }).totpPending = token.totpPending as boolean;
      }
      return session;
    },
  },
};

// Find-or-create a local account from a verified OAuth identity.
export async function ensureOAuthUser(
  email: string,
  name: string,
  providerEmailVerified?: boolean | null,
): Promise<{ id: string; totpEnabled: boolean } | null> {
  const e = email.toLowerCase().trim();
  if (!e) return null;
  // A provider that explicitly reports the address as unverified must not be
  // allowed to claim (and auto-verify) a pending local registration — that is
  // an account-takeover path. Claim absent (null) keeps prior behavior: the
  // configured providers (Google/GitHub) only hand out verified primaries.
  if (providerEmailVerified === false) return null;
  let user = await prisma.user.findUnique({ where: { email: e } });
  if (!user) {
    user = await prisma.user.create({
      data: {
        email: e,
        passwordHash: randomBytes(32).toString("hex"), // OAuth users have no password
        name: name || e.split("@")[0],
        emailVerified: new Date(),
      },
    });
    await signupBonus(user.id);
  } else if (!user.emailVerified) {
    // Pre-hijacking guard: an unverified local account was created by a plain
    // password registration that never proved the address (POST /api/register
    // requires no ownership). Anyone can pre-register an address they don't
    // own — auto-linking the OAuth identity into it would verify it AND leave
    // the attacker's password working on the victim's account. The real owner
    // must first verify via the emailed link (or sign in with the password
    // and verify from there); OAuth sign-in is refused until then.
    return null;
  }
  return { id: user.id, totpEnabled: user.totpEnabled };
}
