import { afterAll, describe, expect, it } from "vitest";
import bcrypt from "bcryptjs";
import fs from "fs";
import os from "os";
import path from "path";

// Pass 63. Four domain audits (auth/session, money, media/providers,
// admin/data/ops). Money held clean again; the verified fixes:
//
//   1. The prompt word list missed plain inflections and split/accented-by-
//      punctuation spellings a reader sees as the blocked word:
//      `under-age girl`, `under age girl`, `chi ld abuse`,
//      `child por nography`, `b omb making`, `nu de woman`, `nudist`,
//      `nakedness`, `bombing`, `weaponize`, `assassinate`, `sexting`,
//      `blood bath` all returned ok. Video output has no audit, so this list
//      is the only pre-filter there.
//   2. `PAYMENT_ALLOW_MOCK=1 PAYMENT_PROVIDER=mock` plus a PUBLIC https
//      NEXTAUTH_URL accepted the signing secret published in this repository:
//      a "test" deployment anyone can reach, with forgeable admin sessions.
//   3. Admin writes re-proved the actor with a plain read. Under READ
//      COMMITTED that cannot see an erasure that is still in flight, so a
//      grant/feedback/takedown committing while the erase transaction sat
//      between its scrub and its commit left the operator id behind — the
//      residue pass 61's scrub exists to remove. The admin erasure also only
//      re-proved at the start, before its multi-second storage sweep.
//   4. A same-site sibling origin could send simple text/plain POSTs that
//      reached the path- and account-keyed limiters (and the sessionVersion
//      read) before readBodyCapped answered 415, draining the victim's own
//      2FA/key/erasure budgets with refused requests.
//   5. MAIL_DEV_DIR and the dev SMTP sink trusted a pre-created file: mode
//      0600 applied only at creation, so a 0666 file (or a world-writable
//      directory) kept receiving live reset/verification links.
//   6. The manual backup scripts pinned modes with umask only, which does not
//      touch existing dumps; and backup.sh's "exactly one compose db" check
//      could pick another checkout's dev database and rotate production dumps.
//   7. writeOffExcessTx's balance clamp inverted into a credit MINT when the
//      balance column was negative (unreachable from the app, but it is the
//      repair path for an already-drifted database).

const { prisma } = await import("../lib/prisma");
const { checkPrompt } = await import("../lib/safety");
const { assertProductionConfig } = await import("../instrumentation");
const { assertAdminActorTx } = await import("../lib/admin");
const { foreignBrowserMutation } = await import("../proxy");
const { getMailer, _setMailerForTests } = await import("../lib/mail");
const { unexplainedFindings, auditReportIsUsable, AUDIT_EXCEPTIONS } = await import(
  "../lib/audit-policy"
);

let seq = 0;
const tag = `pass63-${Date.now()}`;

async function makeUser(extra: Record<string, unknown> = {}) {
  return prisma.user.create({
    data: {
      email: `${tag}-${seq++}@test.dev`,
      passwordHash: bcrypt.hashSync("pass63-password", 4),
      name: "Pass 63",
      ...extra,
    },
  });
}

const SECRET = "2a7d9c4e6b8f1053c9e1d7b4a6f20835";
// The value published in .github/workflows/ci.yml and scripts/ci-local.sh.
const PUBLISHED_CI_SECRET = "5c1f8e2a94b7d03f6ae4c81d2795bf30e6a1c47d8b92f650";

afterAll(async () => {
  await prisma.user.deleteMany({ where: { email: { startsWith: tag } } }).catch(() => undefined);
});

describe("pass 63 — the prompt filter sees ordinary spellings, not just stems", () => {
  it("blocks inflections and split spellings", () => {
    const blocked = [
      // Split after two or more letters — collapseLetterSpacing only joins
      // runs of single letters, and the separated view makes a space a token
      // boundary, so these were invisible to every view.
      "under-age girl",
      "under age girl",
      "chi ld abuse",
      "child por nography",
      "b omb making",
      "nu de woman",
      // Ordinary inflections that were simply never on the list.
      "nudist beach",
      "nudism",
      "nakedness",
      "sexting",
      "bombing a city",
      "bombed out building",
      "weaponize a virus",
      "assassinate the president",
      "assassination plot",
      "blood bath",
      // The pass-62 invisible-character cases stay blocked.
      "nud\u0001e woman",
      "nud\u2800e woman",
      "bomb\u0000making",
      "child\nporn",
    ];
    for (const prompt of blocked) {
      expect(checkPrompt(prompt).ok, JSON.stringify(prompt)).toBe(false);
    }
  });

  it("keeps the false-positive guards already pinned", () => {
    const allowed = [
      "Essex county landscape",
      "a sextant under the stars",
      "a nudibranch on the reef",
      "underagents in a spy thriller",
      // The split-word tolerance must not match ordinary prose: the final
      // `e` of "under age" is followed by another letter, so there is no
      // boundary where "underage" would end.
      "under a gentle sky",
      "under a green tree",
      "a bombastic trumpet solo",
      "a cozy cafe at golden hour",
      "minimalist product shot of a keyboard",
      "sunset over mountains, cinematic",
    ];
    for (const prompt of allowed) {
      expect(checkPrompt(prompt).ok, JSON.stringify(prompt)).toBe(true);
    }
  });
});

describe("pass 63 — the published CI secret needs a local test origin", () => {
  const base = {
    NODE_ENV: "production",
    PAYMENT_ALLOW_MOCK: "1",
    PAYMENT_PROVIDER: "mock",
  };

  it("refuses it on a public https test deployment", () => {
    expect(() =>
      assertProductionConfig({
        ...base,
        NEXTAUTH_SECRET: PUBLISHED_CI_SECRET,
        NEXTAUTH_URL: "https://pixelduo.example.com",
      } as NodeJS.ProcessEnv),
    ).toThrow(/published in \.github\/workflows\/ci\.yml/);
  });

  it("still accepts it on the loopback origins CI and ci-local use", () => {
    for (const url of ["http://localhost:3100", "http://127.0.0.1:3100"]) {
      expect(() =>
        assertProductionConfig({
          ...base,
          NEXTAUTH_SECRET: PUBLISHED_CI_SECRET,
          NEXTAUTH_URL: url,
        } as NodeJS.ProcessEnv),
      ).not.toThrow();
    }
  });

  it("does not restrict a public mock deployment's OWN fresh secret", () => {
    expect(() =>
      assertProductionConfig({
        ...base,
        NEXTAUTH_SECRET: SECRET,
        NEXTAUTH_URL: "https://pixelduo.example.com",
      } as NodeJS.ProcessEnv),
    ).not.toThrow();
  });
});

describe("pass 63 — foreign browser mutations are refused before any bucket", () => {
  it("separates the browser's own label from non-browser clients", () => {
    expect(foreignBrowserMutation("POST", "/api/2fa/disable", "same-site")).toBe(true);
    expect(foreignBrowserMutation("POST", "/api/account/delete", "cross-site")).toBe(true);
    expect(foreignBrowserMutation("PATCH", "/api/admin/feedback/x", "same-site")).toBe(true);
    // Our own pages, and clients that send no Sec-Fetch-* at all (curl,
    // scripts, provider webhooks).
    expect(foreignBrowserMutation("POST", "/api/generate", "same-origin")).toBe(false);
    expect(foreignBrowserMutation("POST", "/api/generate", null)).toBe(false);
    // Reads and navigations are untouched.
    expect(foreignBrowserMutation("GET", "/api/generate", "same-site")).toBe(false);
    // OAuth/OIDC callbacks are cross-site POSTs by design; NextAuth's own
    // CSRF token covers them.
    expect(foreignBrowserMutation("POST", "/api/auth/callback/google", "cross-site")).toBe(false);
    // Non-API paths (the page shells) are not this guard's subject.
    expect(foreignBrowserMutation("POST", "/studio", "same-site")).toBe(false);
  });
});

describe("pass 63 — the admin actor recheck waits for an in-flight erasure", () => {
  it("does not pass on the uncommitted snapshot the erase transaction will replace", async () => {
    const admin = await makeUser({ role: "admin" });
    let locked!: () => void;
    let release!: () => void;
    const lockedAt = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const releaseAt = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Model the erasure exactly: User FOR UPDATE, the cascade, then a commit
    // that lands after the check has already read the (still visible) row.
    const erasure = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${admin.id} FOR UPDATE`;
        await tx.user.delete({ where: { id: admin.id } });
        locked();
        await releaseAt;
      },
      { timeout: 20_000 },
    );
    await lockedAt;
    const check = assertAdminActorTx(prisma, { id: admin.id, sv: 0 });
    let outcome: "resolved" | "rejected" | "pending" = "pending";
    try {
      outcome = await Promise.race([
        check.then(
          () => "resolved" as const,
          () => "rejected" as const,
        ),
        new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 500)),
      ]);
      // A plain SELECT resolves here (the delete is uncommitted and invisible);
      // FOR KEY SHARE blocks on the erasure's FOR UPDATE.
      expect(outcome).toBe("pending");
    } finally {
      // Always let the transaction finish, so a failed assertion cannot leave
      // the row lock held for the next test in the file.
      release();
      await erasure;
    }
    await expect(check).rejects.toMatchObject({ status: 403 });
  }, 20_000);
});

describe("pass 63 — an unpatched advisory is allowed only by its own exception", () => {
  const GHSA = "GHSA-fc5q-39xc-vjpf";
  // The shape npm audit printed for this tree (high findings only).
  const realReport = {
    auditReportVersion: 2,
    vulnerabilities: {
      "@rollup/plugin-commonjs": { name: "@rollup/plugin-commonjs", severity: "high", via: ["@rollup/pluginutils", "picomatch"] },
      "@rollup/pluginutils": { name: "@rollup/pluginutils", severity: "high", via: ["picomatch"] },
      "@sentry/nextjs": { name: "@sentry/nextjs", severity: "high", via: ["@rollup/plugin-commonjs"] },
      picomatch: {
        name: "picomatch",
        severity: "high",
        via: [
          {
            name: "picomatch",
            url: `https://github.com/advisories/${GHSA}`,
            severity: "high",
            range: "<=4.0.7",
          },
        ],
      },
    },
  };

  it("allows the documented chain and nothing else", () => {
    expect(AUDIT_EXCEPTIONS).toEqual([
      expect.objectContaining({ id: GHSA, package: "picomatch", maxAffectedVersion: "4.0.7" }),
    ]);
    expect(unexplainedFindings(realReport)).toEqual([]);
    // The same chain with a SECOND advisory on the allowed package is not
    // covered: the exception names one GHSA, not a package-wide pass.
    const secondAdvisory = JSON.parse(JSON.stringify(realReport));
    secondAdvisory.vulnerabilities.picomatch.via.push({
      name: "picomatch",
      url: "https://github.com/advisories/GHSA-aaaa-bbbb-cccc",
      severity: "high",
    });
    // The allowed package is unexplained, and so is every ancestor that exists
    // only because of it — the gate reports the whole affected chain.
    expect(unexplainedFindings(secondAdvisory)).toContain("picomatch (high)");
    expect(unexplainedFindings(secondAdvisory)).toHaveLength(4);
    // A new advisory on an ancestor is not covered either.
    const ancestorAdvisory = JSON.parse(JSON.stringify(realReport));
    ancestorAdvisory.vulnerabilities["@sentry/nextjs"].via.push({
      name: "@sentry/nextjs",
      url: "https://github.com/advisories/GHSA-dddd-eeee-ffff",
      severity: "high",
    });
    expect(unexplainedFindings(ancestorAdvisory)).toEqual(["@sentry/nextjs (high)"]);
    // And an unrelated package is untouched by the exception.
    const unrelated = JSON.parse(JSON.stringify(realReport));
    unrelated.vulnerabilities.other = {
      name: "other",
      severity: "critical",
      via: [{ name: "other", url: "https://github.com/advisories/GHSA-gggg-hhhh-iiii", severity: "critical" }],
    };
    expect(unexplainedFindings(unrelated)).toEqual(["other (critical)"]);
    // Moderate findings are not the gate's subject.
    const moderate = {
      vulnerabilities: {
        picomatch: {
          name: "picomatch",
          severity: "moderate",
          via: [{ name: "picomatch", url: "https://github.com/advisories/GHSA-jjjj-kkkk-llll", severity: "moderate" }],
        },
      },
    };
    expect(unexplainedFindings(moderate)).toEqual([]);
  });

  it("rejects an npm error envelope instead of reading it as a clean tree", () => {
    // The first version of the script cleared the gate on this shape: `npx`
    // exports npm_config_allow_scripts, the child `npm audit` answers
    // EALLOWSCRIPTS, and `unexplainedFindings({})` is (correctly) empty.
    expect(auditReportIsUsable(realReport)).toBe(true);
    expect(auditReportIsUsable({ auditReportVersion: 2, vulnerabilities: {} })).toBe(true);
    expect(
      auditReportIsUsable({ error: { code: "EALLOWSCRIPTS", summary: "--allow-scripts is not allowed" } }),
    ).toBe(false);
    expect(auditReportIsUsable({ vulnerabilities: {} })).toBe(false);
    expect(auditReportIsUsable(null)).toBe(false);
  });

  it("is wired into both gates and backed by the artifact assertions", () => {
    for (const gate of [".github/workflows/ci.yml", "scripts/ci-local.sh"]) {
      const src = fs.readFileSync(path.join(process.cwd(), gate), "utf8");
      expect(src, gate).toContain("scripts/audit-runtime.ts");
      expect(src, gate).toContain("test ! -e /app/node_modules/picomatch");
      expect(src, gate).toContain("test ! -e /app/node_modules/@rollup");
    }
    expect(fs.readFileSync(path.join(process.cwd(), "Dockerfile"), "utf8")).toContain(
      "node_modules/@rollup node_modules/picomatch",
    );
  });
});

describe("pass 63 — dev auth-mail files are owner-only even when pre-created", () => {
  const origDir = process.env.MAIL_DEV_DIR;
  const origSmtp = process.env.SMTP_URL;

  function restore() {
    if (origDir === undefined) delete process.env.MAIL_DEV_DIR;
    else process.env.MAIL_DEV_DIR = origDir;
    if (origSmtp === undefined) delete process.env.SMTP_URL;
    else process.env.SMTP_URL = origSmtp;
    _setMailerForTests(null);
  }

  it.skipIf(typeof process.getuid !== "function")(
    "tightens a pre-created world-writable directory and 0666 file",
    async () => {
      delete process.env.SMTP_URL;
      _setMailerForTests(null);
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pd63-mail-"));
      const file = path.join(dir, "target@example.com.txt");
      try {
        fs.chmodSync(dir, 0o777);
        fs.writeFileSync(file, "old\n", { mode: 0o666 });
        fs.chmodSync(file, 0o666);
        process.env.MAIL_DEV_DIR = dir;
        await getMailer().send("target@example.com", "subject", "live-reset-link");
        expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
        expect(fs.statSync(file).mode & 0o777).toBe(0o600);
        expect(fs.readFileSync(file, "utf8")).toContain("live-reset-link");
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
        restore();
      }
    },
    20_000,
  );

  it.skipIf(typeof process.getuid !== "function")(
    "refuses a hard-linked file instead of appending a token to it",
    async () => {
      delete process.env.SMTP_URL;
      _setMailerForTests(null);
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pd63-mail-"));
      const file = path.join(dir, "target@example.com.txt");
      try {
        fs.writeFileSync(path.join(dir, "elsewhere.txt"), "untouched\n");
        fs.linkSync(path.join(dir, "elsewhere.txt"), file);
        process.env.MAIL_DEV_DIR = dir;
        await expect(getMailer().send("target@example.com", "subject", "token")).rejects.toThrow(
          /single-link/,
        );
        expect(fs.readFileSync(path.join(dir, "elsewhere.txt"), "utf8")).toBe("untouched\n");
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
        restore();
      }
    },
    20_000,
  );
});
