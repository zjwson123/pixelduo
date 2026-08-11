import type { NextAuthOptions } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import bcrypt from "bcryptjs";
import { prisma } from "./prisma";
import { isLoginBlocked, recordLoginFailure, clearLoginFailures } from "./login-guard";

interface AuthUser {
  id: string;
  email: string;
  name: string | null;
  sessionVersion: number;
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
        return { id: user.id, email: user.email, name: user.name, sessionVersion: user.sessionVersion } as AuthUser;
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token.uid = (user as AuthUser).id;
        token.sv = (user as AuthUser).sessionVersion ?? 0;
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        (session.user as { id?: string }).id = token.uid as string;
        (session.user as { sv?: number }).sv = token.sv as number;
      }
      return session;
    },
  },
};
