import { recoverStuckJobs } from "../lib/queue";
import { assertDatabaseSessionUtc } from "../lib/prisma";

async function main() {
  // recoverStuckJobs judges `now() - COALESCE(heartbeatAt, startedAt)` in SQL
  // (lib/queue.ts): on a session whose TimeZone is not UTC a healthy running
  // job's heartbeat reads hours stale (failed + re-billed while still live) or
  // hours fresh (a dead worker's job never reaped, its pre-auth never
  // refunded). The pin in lib/prisma.ts makes the session UTC; this gate is
  // what catches a URL whose own `options=` (or a pooler that strips ours)
  // left it on local time. Pass 32 — the one deadline-comparing process the
  // pass-31 sweep missed.
  await assertDatabaseSessionUtc();
  const n = await recoverStuckJobs();
  console.log(`[recover] recovered ${n} stuck job(s)`);
}

main().catch((e) => {
  console.error("[recover] failed:", e);
  process.exit(1);
});
