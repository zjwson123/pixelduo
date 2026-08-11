import type { NextAuthOptions } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import bcrypt from "bcryptjs";
import { prisma } from "./prisma";
import { isLoginBlocked, recordLoginFailure, clearLoginFailures } from "./login-guard";
import { verifyPreAuthToken } from "./twofa";

interface AuthUser {
  id: string;
  email: string;
  name: string | null;
  sessionVersion: number;
  totpPending?: boolean;
}

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
        if (!user) return null;
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
  ],
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token.uid = (user as AuthUser).id;
        token.sv = (user as AuthUser).sessionVersion ?? 0;
        token.totpPending = (user as AuthUser).totpPending ?? false;
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
