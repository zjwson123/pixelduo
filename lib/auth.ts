import type { NextAuthOptions } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import GoogleProvider from "next-auth/providers/google";
import GitHubProvider from "next-auth/providers/github";
import bcrypt from "bcryptjs";
import { randomBytes } from "crypto";
import { prisma } from "./prisma";
import { isLoginBlocked, recordLoginFailure, clearLoginFailures } from "./login-guard";
import { verifyPreAuthToken } from "./twofa";
import { signupBonus } from "./ledger";

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
      async authorize(credentials) {
        if (!credentials?.email || !credentials?.password) return null;
        const email = credentials.email.toLowerCase().trim();
        const user = await prisma.user.findUnique({ where: { email } });
        if (!user) {
          await bcrypt.compare(credentials.password, DUMMY_HASH);
          return null;
        }
        if (await isLoginBlocked(email)) return null;
        const ok = await bcrypt.compare(credentials.password, user.passwordHash);
        if (!ok) {
          await recordLoginFailure(email);
          return null;
        }
        await clearLoginFailures(email);
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
    async signIn({ user, account }) {
      if (account?.type !== "oauth") return true;
      const dbUser = await ensureOAuthUser(user.email ?? "", user.name ?? "");
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
): Promise<{ id: string; totpEnabled: boolean } | null> {
  const e = email.toLowerCase().trim();
  if (!e) return null;
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
    await prisma.user.update({ where: { id: user.id }, data: { emailVerified: new Date() } });
  }
  return { id: user.id, totpEnabled: user.totpEnabled };
}
