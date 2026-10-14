process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://pixelduo:pixelduo@localhost:5432/pixelduo_test";
process.env.REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";

import { beforeAll } from "vitest";
import { prisma } from "./lib/prisma";

// Clock coherence, checked once per test file.
//
// The money paths decide expiry by the DATABASE's clock — `now()` inside the SQL
// of spendCreditsTx, refundCreditsTx and the expiry sweep (deliberately: one
// authority, and it is the one the rows live in). The tests that build fixtures
// stamp `expiresAt` from the HOST's clock, which is only equivalent while the two
// agree. When they do not, "a grant that expired a minute ago" is really "a grant
// that expires in fourteen minutes", and no failure names anything close to the
// cause: the sweep sweeps 0, spendCreditsTx accepts credits it must refuse, and
// a refund takes the wrong branch. Measured on this machine after a host sleep:
// Docker Desktop's VM clock lagged the host by 15m25s and the suite ran 1001s
// with five unrelated-looking expiry failures — every one of them the clock.
//
// Refusing to run is deliberate, by the same rule as scripts/check-config.ts
// failing when docker is missing: a green run that verified nothing is worse
// than a red one that says why. Two fixtures use a one-second margin
// (tests/expiry.test.ts), so that is the tolerance. Median of three samples, so a
// loaded machine's slow round trip cannot fake a skew and fail a good run.
beforeAll(async () => {
  const samples: number[] = [];
  for (let i = 0; i < 3; i++) {
    const t0 = Date.now();
    const [row] = await prisma
      .$queryRaw<Array<{ db: Date }>>`SELECT now() AS db`
      .catch(() => [] as Array<{ db: Date }>);
    if (row) samples.push(Math.abs(new Date(row.db).getTime() - (t0 + Date.now()) / 2));
  }
  // No database at all — the tests that need one will say so.
  if (samples.length === 0) return;
  // The median of whatever came back, not `samples[1]` unconditionally: with one
  // surviving sample that index is `undefined`, and `undefined > 1000` is false,
  // so a flaky round trip could produce exactly the green run this guard exists
  // to refuse — the guard disabling itself on the way to its own failure mode.
  const skewMs = samples.sort((a, b) => a - b)[Math.floor(samples.length / 2)];
  if (skewMs > 1000) {
    throw new Error(
      `the database clock is ${(skewMs / 1000).toFixed(1)}s from the host clock, so every ` +
        "expiry/refund result in this run is suspect: those tests write fixture timestamps with " +
        "the host clock and the code compares them against the database's now(). Fix the clock " +
        "before reading any of it as a code regression — `docker restart pixelduo-db` re-syncs " +
        "Docker Desktop's VM clock (it lags after a host sleep), and a host that was just " +
        "corrected by NTP shows the same offset until the container is restarted. " +
        "A skew under that tolerance is still enough to flip a fixture that sits exactly on a " +
        "DAY boundary: daysLeft is Math.ceil'd against the database's now() (lib/credits, " +
        "lib/reminder) and the reminder buckets are [1,3,7], so build day-offset fixtures an " +
        "hour INSIDE the bucket they mean (pass 37 — a fixture at exactly 7 days read as 8 and " +
        "matched no bucket, so the mail was silently skipped).",
    );
  }
});
