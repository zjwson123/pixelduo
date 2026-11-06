import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import bcrypt from "bcryptjs";
import { authenticator } from "otplib";
import Redis from "ioredis";

// Route handlers are driven directly, which is how every hardened route in this
// suite is tested: next-auth's session helper is stubbed, and its App Router
// handler is replaced with a recording stub as well — the real one reaches for
// next/headers' cookies(), which has no request store under vitest, and the
// recording stub is a stronger assertion anyway ("did the account-provisioning
// handler even run?").
const getServerSession = vi.fn();
const delegated: string[] = [];
const nextAuthHandler = vi.fn(async (req: Request) => {
  delegated.push(`${req.method} ${new URL(req.url).pathname}`);
  return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
});
vi.mock("next-auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next-auth")>();
  return {
    ...actual,
    default: () => nextAuthHandler,
    getServerSession: (...args: unknown[]) => getServerSession(...args),
  };
});

const { POST: verifyTwoFactor } = await import("../app/api/auth/2fa-verify/route");
const { POST: confirmTwoFactor } = await import("../app/api/2fa/confirm/route");
const { POST: disableTwoFactor } = await import("../app/api/2fa/disable/route");
const { POST: deleteAccount } = await import("../app/api/account/delete/route");
const { POST: createKey } = await import("../app/api/account/keys/route");
const { POST: authEndpoint } = await import("../app/api/auth/[...nextauth]/route");
const { authOptions } = await import("../lib/auth");
const twofa = await import("../lib/twofa");
const { prisma } = await import("../lib/prisma");

const PASSWORD = "correct-horse-battery-staple";
// Fixed so a code can be generated at will; the enrolment tests in
// tests/credential-revocation.test.ts use the same fixture secret.
const SECRET = "JBSWY3DPEHPK3PXP";
const MAX = twofa.MAX_2FA_FAILURES;

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
const origRedisUrl = process.env.REDIS_URL;
let redisUp = false;
let seq = 0;

beforeAll(async () => {
  const c = new Redis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 0 });
  try {
    await c.connect();
    await c.ping();
    redisUp = true;
  } catch {
    redisUp = false;
  } finally {
    await c.quit().catch(() => undefined);
  }
});

afterAll(async () => {
  await prisma.user.deleteMany({ where: { email: { startsWith: "p15-" } } });
  twofa._resetTwoFaForTests();
  if (origRedisUrl) process.env.REDIS_URL = origRedisUrl;
  else delete process.env.REDIS_URL;
  await prisma.$disconnect();
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.OAUTH_CALLBACK_RATE_LIMIT;
});

// A per-call client address, so the per-minute burst limiters (5/min per IP and
// per account) can never be what a case observes.
function ip(): string {
  return `198.18.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
}

function reqTo(path: string, body: unknown, address = ip()): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": address },
    body: JSON.stringify(body),
  });
}

async function makeUser(extra: Record<string, unknown> = {}) {
  return prisma.user.create({
    data: {
      email: `p15-${Date.now()}-${seq++}@test.dev`,
      passwordHash: bcrypt.hashSync(PASSWORD, 10),
      emailVerified: new Date(),
      name: `pass15 ${seq}`,
      ...extra,
    },
  });
}

function sessionFor(user: { id: string; sessionVersion: number }, totpPending = false) {
  getServerSession.mockResolvedValue({ user: { id: user.id, sv: user.sessionVersion, totpPending } });
}

// verifyTotp accepts one step of drift either way, so this is a second,
// independently valid code for the same secret — needed wherever one test wants
// a "fresh" code without sleeping through a 30s window. The NEXT step rather
// than the previous one, because it stays valid if the clock rolls into a new
// step between generating the code and the request that checks it.
function neighbouringCode(offsetMs = 30_000): string {
  const inst = authenticator.create({ ...authenticator.allOptions(), epoch: Date.now() + offsetMs });
  return inst.generate(SECRET);
}

// ---------------------------------------------------------------------------
// P15-A1, part 1: the cumulative per-account second-factor brake. The
// per-minute limiters bound a burst; at 5 guesses/min sustained, and with 3 of
// the million codes valid at any instant, a month of grinding is ~48% odds for
// anyone who knows the password. The counter is the account-level brake.
// ---------------------------------------------------------------------------
describe("cumulative second-factor brake (pass 15)", () => {
  it("refuses every route that takes a second factor once the account is locked", async () => {
    if (!redisUp) return;
    const user = await makeUser({ totpEnabled: true, totpSecret: SECRET });
    for (let i = 0; i < MAX; i++) await twofa.recordTwoFactorFailure(user.id);
    // A code that would otherwise be accepted: the refusal must be the brake,
    // not a rejected code.
    const code = authenticator.generate(SECRET);

    const cases = [
      { name: "2fa-verify", call: () => verifyTwoFactor(reqTo("/api/auth/2fa-verify", { token: code })) },
      { name: "2fa/confirm", call: () => confirmTwoFactor(reqTo("/api/2fa/confirm", { token: code, password: PASSWORD })) },
      { name: "2fa/disable", call: () => disableTwoFactor(reqTo("/api/2fa/disable", { token: code, password: PASSWORD })) },
      {
        name: "account/keys",
        call: () => createKey(reqTo("/api/account/keys", { name: "locked", password: PASSWORD, token: code })),
      },
      {
        name: "account/delete",
        call: () =>
          deleteAccount(reqTo("/api/account/delete", { confirm: true, password: PASSWORD, token: code })),
      },
    ];

    for (const c of cases) {
      // Every one of these needs a session; the pending one for 2fa-verify.
      sessionFor(user, c.name === "2fa-verify");
      // 2fa/confirm needs a pending secret to be a meaningful check.
      if (c.name === "2fa/confirm") {
        await prisma.user.update({ where: { id: user.id }, data: { totpPendingSecret: SECRET } });
      }
      const res = await c.call();
      expect(res.status, `${c.name} must be refused with a lockout status`).toBe(429);
      expect((await res.json()).error, `${c.name} error`).toBe(twofa.TWOFA_LOCKED_ERROR);
    }

    // Nothing happened behind the refusal: the account is still there, the
    // enrolment is untouched and no credential was minted.
    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.totpEnabled).toBe(true);
    expect(after.totpPendingSecret).toBe(SECRET);
    expect(await prisma.apiKey.count({ where: { userId: user.id } })).toBe(0);
  });

  it("counts a failed code and closes the account at the cap", async () => {
    if (!redisUp) return;
    const user = await makeUser({ totpEnabled: true, totpSecret: SECRET });
    for (let i = 0; i < MAX - 1; i++) await twofa.recordTwoFactorFailure(user.id);
    sessionFor(user, true);

    // Under the cap a wrong code is still just a wrong code...
    const wrong = await verifyTwoFactor(reqTo("/api/auth/2fa-verify", { token: "000000" }));
    expect(wrong.status).toBe(400);
    expect((await wrong.json()).error).toBe("invalid-code");

    // ...but that failure was the one that reached the cap, so the account is
    // now refused before any code is compared.
    expect(await twofa.isTwoFactorLocked(user.id)).toBe(true);
    const locked = await verifyTwoFactor(reqTo("/api/auth/2fa-verify", { token: authenticator.generate(SECRET) }));
    expect(locked.status).toBe(429);
    expect((await locked.json()).error).toBe(twofa.TWOFA_LOCKED_ERROR);
  });

  it("lets a correct code through under the cap, and that success clears the counter", async () => {
    if (!redisUp) return;
    const user = await makeUser({ totpEnabled: true, totpSecret: SECRET });
    for (let i = 0; i < MAX - 1; i++) await twofa.recordTwoFactorFailure(user.id);
    sessionFor(user, true);

    const okRes = await verifyTwoFactor(reqTo("/api/auth/2fa-verify", { token: authenticator.generate(SECRET) }));
    expect(okRes.status).toBe(200);

    // The whole counter is gone, not merely decremented: another full run of
    // failures has to start over before the account closes again.
    expect(await twofa.isTwoFactorLocked(user.id)).toBe(false);
    for (let i = 0; i < MAX - 1; i++) await twofa.recordTwoFactorFailure(user.id);
    expect(await twofa.isTwoFactorLocked(user.id)).toBe(false);
    await twofa.recordTwoFactorFailure(user.id);
    expect(await twofa.isTwoFactorLocked(user.id)).toBe(true);
  });

  it("does not count a wrong password as a second-factor failure", async () => {
    if (!redisUp) return;
    const user = await makeUser({ totpEnabled: true, totpSecret: SECRET });
    for (let i = 0; i < MAX - 1; i++) await twofa.recordTwoFactorFailure(user.id);
    sessionFor(user);

    const wrongPw = await disableTwoFactor(reqTo("/api/2fa/disable", { token: "000000", password: "not-the-password" }));
    expect(wrongPw.status).toBe(400);
    expect((await wrongPw.json()).error).toBe("invalid-password");
    // One more failure, from the counter's point of view, would have closed the
    // account: a password guess must not be able to get the owner locked out.
    expect(await twofa.isTwoFactorLocked(user.id)).toBe(false);
  });

  it("is not cleared by a password login or a password reset; the operator script clears it", async () => {
    if (!redisUp) return;
    const user = await makeUser({ totpEnabled: true, totpSecret: SECRET });
    for (let i = 0; i < MAX; i++) await twofa.recordTwoFactorFailure(user.id);
    expect(await twofa.isTwoFactorLocked(user.id)).toBe(true);

    // The credentials provider's own steps, with the CORRECT password: the
    // refund there clears the login counters only. If it cleared the brake too,
    // the attacker the brake exists for — one who already has the password —
    // could reset it at will and the counter would bound nothing.
    // CredentialsProvider() in next-auth 4.24 keeps the config under `options`
    // (its own top-level `authorize` is a () => null stub) and core/init merges
    // it over the provider at request time — so the real one is here.
    const creds = authOptions.providers.find((p) => p.id === "credentials") as unknown as {
      options: { authorize: (c: Record<string, string>, req: unknown) => Promise<unknown> };
    };
    const authorized = await creds.options.authorize(
      { email: user.email, password: PASSWORD },
      { body: {}, query: {}, headers: {}, method: "POST" },
    );
    expect(authorized).not.toBeNull(); // the password was accepted
    expect(await twofa.isTwoFactorLocked(user.id)).toBe(true);

    // A completed password reset clears the login counters and NOTHING else
    // (pass 46). Forgot-password is self-service, so clearing the brake here
    // bought a mailbox holder a fresh 20 guesses per reset — exactly the
    // sustained 6-digit grind this counter exists to bound. The exit is the
    // brake's own 24h window or the operator script.
    const { clearLoginFailures } = await import("../lib/login-guard");
    await clearLoginFailures(user.email);
    expect(await twofa.isTwoFactorLocked(user.id)).toBe(true);

    // The operator script's clearing call is still the supported exit
    // (scripts/reset-2fa.ts), and it also revokes sessions/keys and mails the
    // owner.
    expect(await twofa.clearTwoFactorFailures(user.id)).toBe(true);
    expect(await twofa.isTwoFactorLocked(user.id)).toBe(false);
  });

  // The refusal is a lockout, not an incident: it must reach the client as a
  // 429 with a message it can tell apart from the burst limiter's
  // "rate-limited", and never as a masked 500 (lib/api.ts expectedStatus).
  it("classifies the lockout as a 429 even when thrown as a plain error", async () => {
    const { fail } = await import("../lib/api");
    const res = fail(new Error(twofa.TWOFA_LOCKED_ERROR));
    expect(res.status).toBe(429);
    expect((await res.json()).error).toBe(twofa.TWOFA_LOCKED_ERROR);
  });

  it("fails closed when the counter cannot be consulted", async () => {
    const prev = process.env.REDIS_URL;
    // A port nothing listens on, and a name that cannot resolve: both make
    // every command fail rather than answer.
    for (const url of ["redis://127.0.0.1:1", "redis://2fa-brake.invalid:6379"]) {
      process.env.REDIS_URL = url;
      twofa._resetTwoFaForTests();
      try {
        // "The store is unreachable" must not read as "no failures recorded".
        expect(await twofa.isTwoFactorLocked("p15-brake-offline")).toBe(true);
        // And the failure paths must not throw their way to a masked 500.
        await expect(twofa.recordTwoFactorFailure("p15-brake-offline")).resolves.toBeUndefined();
        await expect(twofa.clearTwoFactorFailures("p15-brake-offline")).resolves.toBe(false);
        // The one-use claim degrades to per-instance (the same bargain the
        // pre-auth ticket's jti makes), never to unlimited.
        expect(await twofa.claimTotpCode("p15-brake-offline", "123456")).toBe(true);
        expect(await twofa.claimTotpCode("p15-brake-offline", "123456")).toBe(false);
      } finally {
        if (prev) process.env.REDIS_URL = prev;
        else delete process.env.REDIS_URL;
        twofa._resetTwoFaForTests();
      }
    }
    expect(await twofa.isTwoFactorLocked("p15-brake-offline")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// P15-A1, part 2: TOTP replay. verifyTotp accepts a ±1 step window, so a code
// stays valid for up to 90s; without a claim, one accepted code could be
// presented again inside that window on every route that takes it.
// ---------------------------------------------------------------------------
describe("TOTP replay rejection (pass 15)", () => {
  it("refuses a code that was already accepted, and accepts an independent one", async () => {
    if (!redisUp) return;
    const user = await makeUser({ totpEnabled: true, totpSecret: SECRET });
    const code = authenticator.generate(SECRET);
    sessionFor(user, true);

    expect((await verifyTwoFactor(reqTo("/api/auth/2fa-verify", { token: code }))).status).toBe(200);
    const replay = await verifyTwoFactor(reqTo("/api/auth/2fa-verify", { token: code }));
    expect(replay.status).toBe(400);
    expect((await replay.json()).error).toBe("invalid-code");

    // Independently valid code (the neighbouring step), same secret: the claim
    // is keyed per account+code, so nothing else is blocked.
    const other = neighbouringCode();
    expect(other).not.toBe(code);
    expect((await verifyTwoFactor(reqTo("/api/auth/2fa-verify", { token: other }))).status).toBe(200);
  });

  it("claims the code on the re-auth routes (disable), not only on login", async () => {
    if (!redisUp) return;
    const user = await makeUser({ totpEnabled: true, totpSecret: SECRET });
    const code = authenticator.generate(SECRET);
    sessionFor(user, true);
    expect((await verifyTwoFactor(reqTo("/api/auth/2fa-verify", { token: code }))).status).toBe(200);

    sessionFor(user);
    const replay = await disableTwoFactor(reqTo("/api/2fa/disable", { token: code, password: PASSWORD }));
    expect(replay.status).toBe(400);
    expect((await replay.json()).error).toBe("invalid-code");
    // Still enabled — the replay changed nothing.
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).totpEnabled).toBe(true);

    const fresh = neighbouringCode();
    const disabled = await disableTwoFactor(reqTo("/api/2fa/disable", { token: fresh, password: PASSWORD }));
    expect(disabled.status).toBe(200);
  });

  it("claims the code on the credential-minting route (account/keys) too", async () => {
    if (!redisUp) return;
    const user = await makeUser({ totpEnabled: true, totpSecret: SECRET });
    const code = authenticator.generate(SECRET);
    sessionFor(user, true);
    expect((await verifyTwoFactor(reqTo("/api/auth/2fa-verify", { token: code }))).status).toBe(200);

    sessionFor(user);
    const replay = await createKey(reqTo("/api/account/keys", { name: "replay", password: PASSWORD, token: code }));
    expect(replay.status).toBe(400);
    expect((await replay.json()).error).toBe("invalid-code");
    expect(await prisma.apiKey.count({ where: { userId: user.id } })).toBe(0);

    const fresh = await createKey(
      reqTo("/api/account/keys", { name: "fresh", password: PASSWORD, token: neighbouringCode() }),
    );
    expect(fresh.status).toBe(200);
    expect(await prisma.apiKey.count({ where: { userId: user.id } })).toBe(1);
  });

  // The enrolment step deliberately does NOT claim the code: it verifies
  // against the pending secret the caller just minted, and the same 30s code is
  // presented again a moment later when the freshly enabled account signs in.
  // e2e/2fa.spec.ts is exactly this flow (confirm → sign out → TOTP login), so
  // claiming it there would lock the owner out of their own next login.
  it("leaves the enrolment code usable for the sign-in that follows it", async () => {
    if (!redisUp) return;
    const email = `p15-${Date.now()}-${seq++}@test.dev`;
    const user = await prisma.user.create({
      data: {
        email,
        passwordHash: bcrypt.hashSync(PASSWORD, 10),
        emailVerified: new Date(),
        name: "p15 enrol",
        totpPendingSecret: SECRET,
      },
    });
    const code = authenticator.generate(SECRET);
    sessionFor(user);
    const confirmed = await confirmTwoFactor(reqTo("/api/2fa/confirm", { token: code, password: PASSWORD }));
    expect(confirmed.status).toBe(200);

    const enabled = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    sessionFor(enabled, true);
    const login = await verifyTwoFactor(reqTo("/api/auth/2fa-verify", { token: code }));
    expect(login.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// P15-A2: OAuth callbacks mint a verified, credited account in three or four
// requests. The signIn callback cannot carry the cap (next-auth 4.24 hands it
// {user, account, profile} and no request), so the wrapper does — before the
// handler that exchanges the code and provisions the account.
// ---------------------------------------------------------------------------
describe("OAuth callback account-farming cap (pass 15)", () => {
  const ctx = { params: Promise.resolve({ nextauth: ["callback", "google"] }) };

  function callback(address: string, method: "GET" | "POST" = "GET", provider = "google") {
    return new NextRequest(`http://localhost/api/auth/callback/${provider}?code=c&state=s`, {
      method,
      headers: {
        "x-forwarded-for": address,
        ...(method === "POST" ? { "content-type": "application/x-www-form-urlencoded" } : {}),
      },
      ...(method === "POST" ? { body: "csrfToken=tok&code=c&state=s" } : {}),
    });
  }

  it("caps OAuth callbacks per source address, before the handler can create anything", async () => {
    if (!redisUp) return;
    process.env.OAUTH_CALLBACK_RATE_LIMIT = "3";
    const attacker = `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
    delegated.length = 0;

    for (let i = 0; i < 3; i++) {
      const allowed = await authEndpoint(callback(attacker), ctx as never);
      expect(allowed.status).toBe(200);
    }
    expect(delegated).toHaveLength(3);

    const refused = await authEndpoint(callback(attacker), ctx as never);
    expect(refused.status).toBe(429);
    expect((await refused.json()).error).toBe("rate-limited");
    expect(Number(refused.headers.get("Retry-After"))).toBeGreaterThan(0);
    // The account-provisioning handler never ran for the refused request.
    expect(delegated).toHaveLength(3);

    // The provider's redirect is a GET, but a POST callback is the same mint.
    const refusedPost = await authEndpoint(callback(attacker, "POST", "github"), ctx as never);
    expect(refusedPost.status).toBe(429);
    expect(delegated).toHaveLength(3);

    // A different address is unaffected by one attacker's bucket...
    const other = await authEndpoint(callback(`10.${Math.floor(Math.random() * 250)}.1.1`), ctx as never);
    expect(other.status).toBe(200);
    // ...and the password login path is not on this counter at all (it is
    // bounded per account by lib/login-guard.ts instead).
    //
    // The ctx has to describe the route the real router would hand the
    // handler. Pass 54 made the cap read the same decoded `nextauth` segments
    // next-auth dispatches on (the raw pathname could be percent-escaped past
    // it), so reusing the google-shaped ctx here would claim this credentials
    // request is an OAuth mint.
    const credentials = await authEndpoint(
      new NextRequest("http://localhost/api/auth/callback/credentials", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": attacker },
        body: "csrfToken=tok&email=nobody%40test.dev&password=pw",
      }),
      { params: Promise.resolve({ nextauth: ["callback", "credentials"] }) } as never,
    );
    expect(credentials.status).toBe(200);
  });

  it("keeps its default cap when the tuning variable is malformed", async () => {
    if (!redisUp) return;
    // envLimit is what makes this fail closed: a typo falls back to the default,
    // never to "no limit" (Number("not-a-number") is NaN, and every comparison
    // against NaN is false). 30 callbacks fit, the 31st does not — which is the
    // default, so the malformed override did not disable anything.
    process.env.OAUTH_CALLBACK_RATE_LIMIT = "not-a-number";
    const address = `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
    for (let i = 0; i < 30; i++) {
      const res = await authEndpoint(callback(address), ctx as never);
      expect(res.status, `callback ${i + 1} of 30`).toBe(200);
    }
    expect((await authEndpoint(callback(address), ctx as never)).status).toBe(429);
  });
});

// ---------------------------------------------------------------------------
// P15-A4: "the provider vouches for this address" is the only accepted value.
// A claim that is not an explicit boolean used to become null, and null passed
// ensureOAuthUser's `=== false` guard — so "false", 0 or an unexpected type was
// read as "no information" and trusted, which against a pre-existing verified
// local account is account takeover.
// ---------------------------------------------------------------------------
describe("OAuth email_verified claims (pass 15)", () => {
  const signIn = authOptions.callbacks!.signIn!;

  async function oauthSignIn(profile: unknown, provider: string, email: string): Promise<boolean> {
    return (await signIn({
      user: { id: "p15-oauth", email, name: "OAuth User" },
      account: { type: "oauth", provider, access_token: "tok" },
      profile: profile as never,
    } as never)) as boolean;
  }

  async function victim(email: string) {
    return prisma.user.create({
      data: { email, passwordHash: "victim-hash", name: "Victim", emailVerified: new Date() },
    });
  }

  it("treats a false-ish claim as unverified, whatever type carries it", async () => {
    for (const claim of [false, 0, "false", "0"]) {
      const email = `p15-${Date.now()}-${seq++}@test.dev`;
      const user = await victim(email);
      expect(await oauthSignIn({ email_verified: claim }, "google", email), `claim ${JSON.stringify(claim)}`).toBe(
        false,
      );
      // The local account is untouched: not linked, not re-verified.
      const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
      expect(after.passwordHash).toBe("victim-hash");
    }
  });

  it("refuses when the claim carries no verdict and there is no API to ask", async () => {
    // Google publishes the claim in its id_token; if it is absent (or is a
    // spelling that settles nothing) we cannot tell whether the address is
    // verified, so the sign-in is refused instead of trusting silence.
    for (const profile of [{}, { email_verified: "true" }, { email_verified: 1 }, { email_verified: null }]) {
      const email = `p15-${Date.now()}-${seq++}@test.dev`;
      expect(await oauthSignIn(profile, "google", email), `profile ${JSON.stringify(profile)}`).toBe(false);
      // Refused before any account is minted.
      expect(await prisma.user.findUnique({ where: { email } })).toBeNull();
    }
  });

  it("still provisions an explicitly verified Google address", async () => {
    const email = `p15-${Date.now()}-${seq++}@test.dev`;
    expect(await oauthSignIn({ email_verified: true }, "google", email)).toBe(true);
    const db = await prisma.user.findUniqueOrThrow({ where: { email } });
    expect(db.emailVerified).not.toBeNull();
    expect(db.credits).toBe(30);
  });

  it("still resolves GitHub's missing claim against GitHub's own email list", async () => {
    const verified = `p15-${Date.now()}-${seq++}@test.dev`;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([{ email: verified, verified: true }]), { status: 200 })));
    expect(await oauthSignIn({}, "github", verified)).toBe(true);
    vi.unstubAllGlobals();

    const unverified = `p15-${Date.now()}-${seq++}@test.dev`;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify([{ email: unverified, verified: false }]), { status: 200 })),
    );
    expect(await oauthSignIn({}, "github", unverified)).toBe(false);
    expect(await prisma.user.findUnique({ where: { email: unverified } })).toBeNull();
  });
});
