import { PrismaClient } from "@prisma/client";

// Pin the session timezone to UTC on every connection this process opens.
//
// Pass 31 found the timezone-shaped half of the mixed-clock family passes
// 26-30 kept closing: Prisma maps DateTime to `timestamp WITHOUT time zone`
// and binds a JS Date as its UTC rendering, which is timezone-independent — but
// the raw SQL in the money/queue paths uses `now()`, and a timestamptz
// assigned to (or compared with) a naive column is rendered through the
// SESSION timezone. So `"startedAt" = now()` and `"expiresAt" > now()` were
// UTC-correct only while the session's TimeZone happened to be UTC, and
// DEFAULT CURRENT_TIMESTAMP columns (every `@default(now())`: Job.createdAt,
// CreditGrant.createdAt — the carryover witness) are stamped the same way. On a
// database whose default is Asia/Shanghai (probed) the two renderings differ by
// 8 hours in BOTH directions: Prisma-written deadlines read as expired inside
// SQL (paid credits unspendable, then destroyed early by the sweep) and
// SQL-written schedules land 8 hours away (a video job's first poll not
// claimable for 8h, its task age computing negative so the 30-minute cap never
// fires) — or the mirror image on a database behind UTC (backoffs and poll
// spacing collapse, the retry spacing pass 27 exists for silently gone).
//
// The fix is one connection-level setting rather than a rewrite of every SQL
// site: `options=-c timezone=UTC` is honored by the Prisma Postgres connector
// (probed: SHOW timezone answers UTC / Asia/Shanghai as instructed). An
// operator-supplied `options=` is left alone — their parameter wins — and
// assertDatabaseSessionUtc() refuses to start in production if the session did
// not end up on UTC (instrumentation.ts, scripts/worker.ts and the three
// maintenance scripts), which covers a pooler that strips the parameter and a
// runtime that sets DATABASE_URL after this module was imported (in which case
// the append below never saw it).
export function withUtcTimezone(url: string | undefined): string | undefined {
  if (!url) return url;
  if (/[?&]options=/.test(url)) return url;
  const sep = url.includes("?") ? (url.endsWith("?") || url.endsWith("&") ? "" : "&") : "?";
  return `${url}${sep}options=-c%20timezone%3DUTC`;
}

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

// The pin is applied to the ENVIRONMENT, not to the client constructor.
//
// Passing `datasources: { db: { url: … } }` looked cleaner and was a trap, found
// by this pass's own suite: the URL is captured at MODULE INIT, while Prisma's
// schema-level `env("DATABASE_URL")` is resolved LAZILY at connect time. Any
// runtime that sets the environment after importing this module — which is
// exactly what the test harness does (vitest.setup.ts assigns DATABASE_URL after
// its hoisted imports, so yes, the module sees the .env value first) — would
// then hold a client pinned to the wrong database: the suite created its
// fixtures in the DEV database while a spawned child read the test one, and a
// "user not found" three files away was the only symptom. Rewriting the env var
// keeps the lazy resolution (late setters still win, as before) and still pins
// every client created from here on, including the ones in scripts/*.ts that
// construct PrismaClient directly.
function pinDatasourceTimezone(): void {
  const pinned = withUtcTimezone(process.env.DATABASE_URL);
  if (pinned && pinned !== process.env.DATABASE_URL) process.env.DATABASE_URL = pinned;
}
pinDatasourceTimezone();

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;

// The session's TimeZone, read from the server. Kept next to the pin above so
// the two cannot drift apart. Throws if the database is unreachable — callers
// decide whether that is fatal (at boot it is: every money decision below
// depends on the answer).
export async function databaseSessionTimezone(client: PrismaClient = prisma): Promise<string> {
  const rows = await client.$queryRaw<Array<{ TimeZone: string }>>`SHOW timezone`;
  return rows[0]?.TimeZone ?? "";
}

// Fail-closed boot assertion for the pin above. Production only, like every
// other boot gate: dev and the test suite run against the compose database
// (UTC by default) and must stay usable without configuration.
//
// The verdict is the zone's UTC OFFSET, sampled at three instants — not the
// zone's NAME (pass 38). `SHOW timezone` echoes the spelling the session was
// given for every canonical name, so a deployment whose server/role default is
// one of the OTHER correct spellings — Etc/UTC and GMT are the stock values on
// Debian/Ubuntu images and in many postgresql.conf files — was refused at boot
// with "the database session timezone is Etc/UTC, not UTC" even though every
// rendering is already exactly right: web in a restart loop, the worker and all
// four cron scripts exiting non-zero, and an error message that asserts
// something untrue, which is what sends the operator doubting the rest of it
// (probed: UTC, Etc/UTC and GMT all render now() at +00 and were worth
// accepting; Etc/GMT+12 at −43200, refused). Two samples six months apart cover
// both DST regimes, so a zone that merely HAPPENS to sit at +00 today
// (Europe/London in winter) is still refused — its naive timestamps would be an
// hour off for half the year — while every fixed zero-offset zone (UTC,
// Etc/UTC, GMT, Zulu, UCT, Universal, Africa/Abidjan, Atlantic/Reykjavik…) is
// accepted. Reachable when an operator supplies their own `options=` (the pin
// deliberately leaves it alone) or a pooler strips ours.
export async function assertDatabaseSessionUtc(opts?: {
  env?: NodeJS.ProcessEnv;
  client?: PrismaClient;
}): Promise<void> {
  const env = opts?.env ?? process.env;
  // Imported lazily to keep this module's import graph small (it is loaded by
  // the worker and by tests that never touch production gating).
  const { isProductionRuntime } = await import("./runtime-env");
  if (!isProductionRuntime(env)) return;
  const client = opts?.client ?? prisma;
  const [row] = await client.$queryRaw<
    Array<{ tz: string; nowOff: number; janOff: number; julOff: number }>
  >`SELECT current_setting('TimeZone') AS tz,
       EXTRACT(timezone FROM now())::int AS "nowOff",
       EXTRACT(timezone FROM TIMESTAMPTZ '2026-01-15 12:00:00+00')::int AS "janOff",
       EXTRACT(timezone FROM TIMESTAMPTZ '2026-07-15 12:00:00+00')::int AS "julOff"`;
  const fixedUtc = row !== undefined && row.nowOff === 0 && row.janOff === 0 && row.julOff === 0;
  if (!fixedUtc) {
    const tz = row?.tz ?? "";
    const offsets = row ? ` (offsets ${row.nowOff}s now, ${row.janOff}s in January, ${row.julOff}s in July)` : "";
    // The remediation names the exact parameter for THIS url: pasted onto one
    // that already carries a query string (a managed provider's
    // ?sslmode=require, a pooler's ?pgbouncer=true), a second "?" makes Prisma
    // reject the whole URL — the operator follows the message and gets a
    // different startup failure (pass 32).
    const param = (env.DATABASE_URL ?? "").includes("?")
      ? "&options=-c%20timezone%3DUTC"
      : "?options=-c%20timezone%3DUTC";
    throw new Error(
      `the database session timezone is ${tz || "unknown"}, not UTC${offsets} — every deadline, schedule and timestamp comparison in this app assumes UTC-naive storage (see lib/prisma.ts). Append ${param} to DATABASE_URL, or set the database/role default (ALTER DATABASE <db> SET timezone TO 'UTC')`,
    );
  }
}

// PostgreSQL's deadlock_detected. Prisma wraps it differently depending on
// whether the statement was raw (`$queryRaw` → P2010 with the SQLSTATE in
// `meta.code`) or one of its own (`... → PrismaClientKnownRequestError` whose
// message carries "40P01"), so match on every shape rather than one spelling.
function isDeadlock(e: unknown): boolean {
  if (!e || typeof e !== "object") return false;
  const err = e as { code?: unknown; message?: unknown; meta?: { code?: unknown; message?: unknown } };
  const text = [err.message, err.meta?.message]
    .filter((s): s is string => typeof s === "string")
    .join(" ");
  return (
    err.code === "40P01" ||
    err.meta?.code === "40P01" ||
    text.includes("40P01") ||
    text.toLowerCase().includes("deadlock detected")
  );
}

// Retry a transaction that PostgreSQL chose as a deadlock victim.
//
// Deliberately narrow: only 40P01 is retried, so a business error (or any other
// SQLSTATE) still surfaces on the first attempt. Callers must pass a closure
// that is idempotent — a rolled-back transaction leaves nothing behind, so a
// re-run re-reads the same state and reaches the same decision, which is true of
// every use here (read ⇒ decide ⇒ delete/decrement).
//
// The erasure routes are the reason this exists. A total lock order is only
// total over the writers that exist today (four of them take the Order or Job
// row before the grants), and the cost of being wrong about the next one is a
// 500 on the one route whose whole contract is that the customer can retry.
export async function withDeadlockRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (attempt >= attempts || !isDeadlock(e)) throw e;
    }
  }
}
