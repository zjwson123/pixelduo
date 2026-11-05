import type { NextAuthOptions } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import GoogleProvider from "next-auth/providers/google";
import GitHubProvider from "next-auth/providers/github";
import { Prisma } from "@prisma/client";
import bcrypt from "bcryptjs";
import { randomBytes } from "crypto";
import { reserveLoginAttempt, refundLoginFailures, alertLoginAbuse } from "./login-guard";
import { ipBucketAddress } from "./rate-limit";
import { prisma } from "./prisma";
import { verifyPreAuthToken } from "./twofa";
import { signupBonus } from "./ledger";
import { readJsonCapped } from "./store";
import { authCookies } from "./auth-cookies";

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
  // /64, not /128 (pass 39): an IPv6 client rotates privacy addresses inside
  // its own /64, and without the mask the per-(email, IP) counter could be
  // split at will — the per-email hard cap still bound the campaign, but a
  // targeted address lost the cheaper pair brake entirely.
  return parts.length > 0 ? ipBucketAddress(parts[parts.length - 1]) : undefined;
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

// GitHub's NextAuth provider builds `profile.email` from /user/emails as
// `emails.find(e => e.primary) ?? emails[0]` and never looks at the `verified`
// flag, and the profile it maps carries no `email_verified` claim at all — so
// the "claim absent means the provider vouches for the address" assumption in
// ensureOAuthUser is simply false for GitHub. A user can add an address they do
// not own to their own GitHub account and have it surface here, which would
// auto-link them straight into the real owner's account (and, for an
// already-verified local account, hand them a full session with no password
// and no second factor). Confirm the address against GitHub's own list before
// trusting it; unverifiable ⇒ refuse the sign-in.
async function githubEmailVerified(accessToken: string | undefined, email: string): Promise<boolean> {
  if (!accessToken) return false;
  const target = email.toLowerCase().trim();
  if (!target) return false;
  try {
    const res = await fetch("https://api.github.com/user/emails", {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "pixelduo",
      },
      signal: AbortSignal.timeout(10_000),
    });
    // Read the body inside the armed window (undici's bodyTimeout is an idle
    // timer) and cancel it when we don't need it.
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      return false;
    }
    // Capped like every sibling outbound read (providers, safety, router): the
    // 10s timeout bounds TIME, not bytes, and this was the one uncapped
    // res.json() left in the codebase — a hostile/compromised response (or a
    // TLS middlebox) could grow the heap without limit.
    const list = (await readJsonCapped(res, 256 * 1024)) as unknown as Array<{
      email?: unknown;
      verified?: unknown;
    }>;
    return list.some(
      (e) => typeof e.email === "string" && e.email.toLowerCase() === target && e.verified === true,
    );
  } catch {
    return false;
  }
}

// The verdict carried by a provider's `email_verified` claim. Only an explicit
// boolean true is the provider vouching for the address; the false-ish
// spellings providers (and the OIDC libraries in front of them) actually emit
// are the refusal they mean; anything else carries no verdict at all and has to
// be resolved against the provider — or refused.
function emailVerifiedClaim(claim: unknown): boolean | null {
  if (claim === true) return true;
  if (claim === false || claim === 0 || claim === "false" || claim === "0") return false;
  return null;
}

// A control character in an address is garbage no user typed and no provider
// emits, and a NUL specifically reaches PostgreSQL as SQLSTATE 22021: the
// credentials callback's lookup dies with an UNEXPECTED error, and next-auth
// reflects the exception's message to the caller (401, message = the Prisma
// invocation snippet with build paths and the Postgres error) — on an
// anonymous, pre-login endpoint. The auth route's raw-body NUL check cannot
// see this one: `{"email":"a\u0000b"}` is ASCII on the wire and a real U+0000
// only after JSON.parse, exactly the escape gap pass 25 closed for JSON routes
// (parseJsonBody); this is the credentials body, which next-auth parses
// itself, so the refusal lives here instead.
function hasControlChars(value: string): boolean {
  // Ill-formed UTF-16 (a lone surrogate) rides the same door: `\ud800` is six
  // ASCII characters on the wire and an unpaired half after JSON.parse, the
  // lookup then throws InvalidArg and next-auth reflects the invocation
  // snippet. Refused by the same uniform null (pass 30).
  return /[\u0000-\u001f\u007f]/.test(value) || !value.isWellFormed();
}

export const authOptions: NextAuthOptions = {
  session: { strategy: "jwt" },
  pages: { signIn: "/login" },
  // `__Host-` in production (see lib/auth-cookies.ts): next-auth's default
  // `__Secure-` names accept a Domain attribute, so a sibling subdomain could
  // plant a session cookie — or OAuth state/PKCE pair — for the parent domain
  // and win the duplicate-name race, logging the victim into the attacker's
  // account. CSRF keeps next-auth's own default (already `__Host-` under
  // https). Existing sessions re-login once, because the old cookie name cannot
  // serve the new one.
  cookies: authCookies(),
  providers: [
    CredentialsProvider({
      name: "credentials",
      credentials: { email: {}, password: {} },
      async authorize(credentials, req) {
        if (!credentials?.email || !credentials?.password) return null;
        // typeof, not just truthiness: next-auth hands authorize the raw parsed
        // body, so `{"email":123}` (or an object password) passes the falsy
        // test and then throws inside a string method / bcrypt — and next-auth
        // reflects the thrown message to the caller as the 401's error=
        // parameter ("credentials.email.toLowerCase is not a function",
        // bcryptjs's "Illegal arguments: object, string"). Refused uniformly
        // with a wrong password, so neither the input shape nor runtime
        // internals leak.
        if (typeof credentials.email !== "string" || typeof credentials.password !== "string") return null;
        // The password gets its own well-formedness check, before any bcrypt
        // call: bcryptjs throws "Invalid string / salt: Not a string" on a lone
        // surrogate (probed), and next-auth reflects the message — the same
        // leak the email guard below closes, by the same uniform refusal. Also
        // before reserveLoginAttempt, so garbage input cannot spend a real
        // account's login budget.
        if (!credentials.password.isWellFormed()) return null;
        const email = credentials.email.toLowerCase().trim();
        // Refused as the non-credential it is — uniform with a wrong password,
        // so nothing about accounts leaks (see hasControlChars).
        if (hasControlChars(email)) return null;
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
        if (!attempt.allowed) {
          // A refused reservation used to return BEFORE any KDF work (pass 39),
          // while an unknown address always pays the dummy compare. Once the
          // per-pair cap tripped, that made the 11th request an existence
          // oracle: ~2 ms = a real account (the lockout answered), ~57 ms =
          // none. The brake still refuses the attempt; the cost is the same
          // either way, so the response does not disclose which.
          await bcrypt.compare(credentials.password, DUMMY_HASH);
          return null;
        }
        // OAuth-created accounts store a random hex placeholder instead of a
        // bcrypt hash (see ensureOAuthUser). bcryptjs rejects it in ~0 ms, so
        // an existing OAuth account answered a password login an order of
        // magnitude faster than an unknown address and leaked its existence
        // (pass 39). Pay the dummy cost instead; there is no password that
        // could match, so the verdict is fixed.
        const usable = hasUsablePassword(user.passwordHash);
        const ok = usable
          ? await bcrypt.compare(credentials.password, user.passwordHash)
          : (await bcrypt.compare(credentials.password, DUMMY_HASH), false);
        if (!ok) {
          // Fire-and-forget: the owner learns about a distributed grind, and
          // the caller's response time doesn't depend on SMTP. Never awaited
          // into the failure path — a mail error must not change the outcome.
          void alertLoginAbuse(email).catch(() => undefined);
          return null;
        }
        // Correct password: refund this attempt from both counters. Not
        // clearLoginFailures, which would also drop the account-keyed login
        // counters this attempt is refunding — and a correct password must not
        // buy a fresh budget of second-factor guesses (the brake is
        // account-keyed and only a 2FA success or the operator script clears
        // it; a password reset deliberately does not either — see
        // lib/login-guard.ts's clearLoginFailures).
        await refundLoginFailures(email, ip);
        if (user.totpEnabled) {
          const pre = (credentials as Record<string, string>).preAuthToken;
          // Second step: password + valid one-time 2FA ticket → real session.
          if (pre && (await verifyPreAuthToken(pre, email, user.sessionVersion))) {
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
    // Every /api/auth/* request carries an optional `callbackUrl`, and next-auth
    // validates it through this callback BEFORE it looks at the CSRF token or
    // the session. The default (`if (url.startsWith("/")) … else new URL(url)`)
    // throws on anything a non-string body rejected: `/api/auth/session?
    // callbackUrl=foo` is a GET whose URL parser throw escapes the route
    // wrapper as a bare 500 plus one captured incident per request, i.e. an
    // anonymous incident faucet reachable from an <img> tag; a relative
    // callbackUrl with CR/LF or non-Latin-1 characters reached
    // `headers.set("Location", …)` on signout and threw there instead. Resolve
    // every input against our own origin, accept only same-origin results, and
    // return the parser's percent-encoded form — ASCII by construction, so it
    // is a valid header value whatever the caller sent.
    async redirect({ url, baseUrl }) {
      if (typeof url !== "string") return baseUrl;
      try {
        const target = new URL(url, baseUrl);
        if (target.origin !== baseUrl) return baseUrl;
        return target.href;
      } catch {
        return baseUrl;
      }
    },
    // OAuth: find-or-create the local account (providers verify the email).
    // Users with 2FA enabled must keep using password login — otherwise OAuth
    // would silently bypass the second factor.
    async signIn({ user, account, profile }) {
      if (account?.type !== "oauth") return true;
      // Resolve the provider's own email_verified claim so an address the
      // provider does not vouch for can never auto-verify (or auto-link into) a
      // local account. The claim used to be read as
      // `typeof claim === "boolean" ? claim : null`, and null slipped past
      // ensureOAuthUser's `=== false` guard — so `email_verified: "false"` (or
      // 0, or "0", or whatever type a provider or a proxy in front of it
      // produced) was read as "no information" and the address was trusted,
      // which against a pre-existing verified local account is account
      // takeover. Only an explicit boolean true is vouching; everything else is
      // resolved here or refused.
      const claim = (profile as { email_verified?: unknown } | undefined)?.email_verified;
      const claimed = emailVerifiedClaim(claim);
      let emailVerified: boolean;
      if (claimed !== null) {
        emailVerified = claimed;
      } else if (account.provider === "github") {
        // GitHub publishes no such claim at all (see githubEmailVerified), so
        // its answer comes from the provider's own /user/emails list.
        emailVerified = await githubEmailVerified(
          account.access_token as string | undefined,
          user.email ?? "",
        );
      } else {
        // No claim, and no provider API to resolve it against — Google
        // publishes the claim in its id_token, so a missing one means we cannot
        // tell whether the address is verified. Refuse rather than treat
        // silence as consent.
        emailVerified = false;
      }
      const dbUser = await ensureOAuthUser(user.email ?? "", user.name ?? "", emailVerified);
      if (!dbUser) return false;
      if (dbUser.totpEnabled) return false;
      return true;
    },
    async jwt({ token, user, account }) {
      if (user) {
        if (account?.type === "oauth") {
          // OAuth first sign-in: map the provider profile to our account.
          //
          // totpEnabled is re-checked HERE, in the same read that stamps sv
          // (pass 31): signIn refuses a 2FA account, but its read and this one
          // happen at two separate instants, so an enablement committing in
          // between used to mint a token carrying the POST-bump version — a full
          // session for an account that now has 2FA, which is exactly what
          // signIn's refusal exists to prevent. Reading the verdict and the
          // version together closes it from both sides: an enablement before
          // this read leaves totpEnabled true (no session is stamped below), and
          // one after it leaves sv stale, which every guard already rejects.
          const db = await prisma.user.findUnique({
            where: { email: (user.email ?? "").toLowerCase().trim() },
            select: { id: true, sessionVersion: true, totpEnabled: true },
          });
          if (db && !db.totpEnabled) {
            token.uid = db.id;
            token.sv = db.sessionVersion;
            token.totpPending = false;
          }
        } else {
          token.uid = (user as AuthUser).id;
          // No `?? 0` (pass 31): sessionUser now refuses a token whose sv is not
          // a number, because the default read as "version 0" and authenticated
          // every account whose counter had never been bumped (pass 30). Minting
          // with the same default was that guard's twin — a credentials path
          // that stopped stamping the field would mint a token that works almost
          // everywhere. All three authorize branches stamp it; if one ever
          // stops, fail loudly at mint time instead of shipping a universal
          // session.
          const sv = (user as AuthUser).sessionVersion;
          if (typeof sv !== "number") {
            throw new Error("authorize returned a user without sessionVersion — refusing to mint a session");
          }
          token.sv = sv;
          token.totpPending = (user as AuthUser).totpPending ?? false;
        }
        return token;
      }
      // READ PATH (no `user`): a session read — getServerSession in every
      // guard, and next-auth's own GET /api/auth/session. next-auth re-encodes
      // whatever this returns with a FRESH 30-day expiry on every call to that
      // route, so a cookie whose sessionVersion was bumped stayed a
      // self-renewing credential: its holder re-dated it forever, and the
      // endpoint answered it with the account's identity while every guarded
      // route 401'd (probed: after revoke-sessions, /api/me → 401 but
      // /api/auth/session → 200 plus a new cookie whose iat/exp moved on each
      // call with sv stale in every one). Revocation has to be decided where
      // the credential is READ, not only where its data is used, so the
      // version is re-asked here and a token that cannot prove it is live is
      // returned with its identity stripped — the session callback below then
      // reports no user, and the guards refuse it on their own check as well.
      //
      // This is one indexed primary-key read per authenticated request, the
      // same read requireUserId already makes; unauthenticated requests
      // (no cookie) never reach it. A token with an id but no numeric sv is
      // stripped too: it cannot be revocation-checked at all, which is the
      // case sessionUser() refuses one layer down. `sub` is the fallback id —
      // next-auth v4 sets it to our own user id, so a token minted before the
      // `uid` claim existed is still checked (and, having no sv, stripped)
      // rather than left echoing an identity next-auth would re-encode.
      const id =
        typeof token.uid === "string" ? token.uid : typeof token.sub === "string" ? token.sub : null;
      const sv = typeof token.sv === "number" ? token.sv : null;
      if (id) {
        const db = await prisma.user.findUnique({ where: { id }, select: { sessionVersion: true } });
        if (!db || db.sessionVersion !== sv) {
          delete token.uid;
          delete token.sv;
          delete token.totpPending;
          // Identity next-auth's own session route reads straight off the
          // decoded token, bypassing our session callback's fields: leaving
          // them in kept echoing the account's name, email and picture to the
          // holder of a revoked cookie on every re-date.
          delete token.sub;
          delete token.email;
          delete token.name;
          delete token.picture;
        }
      }
      return token;
    },
    async session({ session, token }) {
      if (typeof token.uid !== "string") {
        // No identity on the token (see the read path above): report an empty
        // session so the route cannot re-hand the account's identity to a
        // cookie the DB has already refused.
        (session as { user?: unknown }).user = undefined;
        return session;
      }
      if (session.user) {
        (session.user as { id?: string }).id = token.uid as string;
        (session.user as { sv?: number }).sv = token.sv as number;
        (session.user as { totpPending?: boolean }).totpPending = token.totpPending as boolean;
      }
      return session;
    },
  },
};

// Does this account actually have a password the owner chose?
//
// OAuth-created accounts are stored with `randomBytes(32).toString("hex")` as a
// placeholder (the column is not nullable) — 64 hex characters, never a valid
// bcrypt hash, so no password can ever match it. Everything else is a real
// bcrypt hash. The verification route uses this to decide whether the
// registrant must prove knowledge of the password before an account becomes
// verified: a placeholder proves nothing (there is no attacker-chosen
// credential to bind), while a real hash is the credential that has to be bound
// to the mailbox link.
export function hasUsablePassword(passwordHash: string | null | undefined): boolean {
  return typeof passwordHash === "string" && passwordHash.startsWith("$2");
}

// The re-auth guard for the routes that ask for the account password
// (2fa/setup, 2fa/confirm, 2fa/disable, account/keys, account/delete). An
// account created through Google/GitHub has NO password — its `passwordHash` is
// a random hex placeholder — so bcrypt.compare can never succeed and all five
// routes answered "wrong password" forever, with nothing anywhere able to tell
// a placeholder from a password its owner forgot. Enabling 2FA, minting a
// pd_live_ key and the erasure endpoint that docs/compliance/privacy.md names
// as the deletion path were dead ends for those accounts.
//
// Returns the error fail() should answer with, or null when the account can
// answer the question. Refusing (rather than exempting the compare) is
// deliberate: an OAuth identity alone must not be enough to bind someone's
// authenticator or erase the account, and the mailbox is a way out that already
// exists — an OAuth account's address is verified, so /forgot-password can set
// a password for it. Hence a message that names the next step instead of a bare
// refusal. `cannot-` is what fail() maps to a 400 (lib/api.ts).
export function passwordReauthRefusal(passwordHash: string | null | undefined): Error | null {
  if (hasUsablePassword(passwordHash)) return null;
  return new Error(
    "cannot-reauth-oauth: this account signs in with a social provider and has no password yet — set one with “Forgot password”, then try again",
  );
}

// Find-or-create a local account from a verified OAuth identity.
//
// `providerEmailVerified` defaults to REFUSAL, not to "no information": making
// "the provider vouches for this address" the only accepted value means a
// caller that forgets the argument, or forwards a claim it could not resolve,
// cannot be the difference between a refusal and an auto-verified account. A
// provider that explicitly reports the address as unverified — or that
// publishes no claim we could verify ourselves (GitHub: see
// githubEmailVerified, which resolves the claim from the provider's API) — must
// not be allowed to claim (and auto-verify) a pending local registration: that
// is an account-takeover path.
export async function ensureOAuthUser(
  email: string,
  name: string,
  providerEmailVerified = false,
): Promise<{ id: string; totpEnabled: boolean } | null> {
  const e = email.toLowerCase().trim();
  if (!e) return null;
  if (providerEmailVerified !== true) return null;
  // Same refusal as the credentials path: a control character (a NUL
  // specifically) would die inside the lookup/create below as SQLSTATE 22021 —
  // an unexpected error reflected to the browser by next-auth's error page.
  if (hasControlChars(e)) return null;
  let user = await prisma.user.findUnique({ where: { email: e } });
  if (!user) {
    try {
      // The account and its signup bonus commit together (pass 39): split into
      // two transactions, a failure after the create left an OAuth account that
      // no later sign-in re-creates and that would never receive the 30
      // credits.
      user = await prisma.$transaction(async (tx) => {
        const created = await tx.user.create({
          data: {
            email: e,
            passwordHash: randomBytes(32).toString("hex"), // OAuth users have no password
            // Display metadata, not user-authored content, so it is filtered rather
            // than refused: control characters would hit the same 22021 on the
            // create, and no legitimate provider sends them.
            name: (name || e.split("@")[0]).replace(/[\u0000-\u001f\u007f]/g, ""),
            emailVerified: new Date(),
          },
        });
        await signupBonus(created.id, tx);
        return created;
      });
    } catch (err) {
      // Two concurrent first-sign-ins for the same new address (a double-tab
      // sign-in, a retried callback) both miss the lookup above and race on
      // the unique index; the loser's create throws P2002. Escaping that is
      // what next-auth turns into /error?error=Callback plus a logged
      // incident for a legitimate sign-in — the register route answers the
      // identical race deliberately (app/api/register/route.ts). The row that
      // WON is the account this sign-in means, so re-read it; the bonus is not
      // granted twice (the winner already granted it inside its own call).
      if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002")) throw err;
      user = await prisma.user.findUnique({ where: { email: e } });
      if (!user) throw err;
    }
  }
  if (!user.emailVerified) {
    // Pre-hijacking guard: an unverified local account was created by a plain
    // password registration that never proved the address (POST /api/register
    // requires no ownership). Anyone can pre-register an address they don't
    // own — auto-linking the OAuth identity into it would verify it AND leave
    // the attacker's password working on the victim's account. The real owner
    // must first verify via the emailed link (or sign in with the password
    // and verify from there); OAuth sign-in is refused until then. Also the
    // correct answer for the race above when the winner was NOT this flow.
    return null;
  }
  return { id: user.id, totpEnabled: user.totpEnabled };
}
