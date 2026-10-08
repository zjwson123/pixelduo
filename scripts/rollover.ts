import { runRollover } from "../lib/rollover";
import { assertDatabaseSessionUtc } from "../lib/prisma";
import { initObservability, captureError } from "../lib/observability";

initObservability("rollover");

async function main() {
  // Refuse to run maintenance against a session that is not on UTC: this pass
  // compares planRenewsAt against SQL now() (lib/prisma.ts documents the pin and
  // why a local-time session shifts every such comparison).
  await assertDatabaseSessionUtc();
  const total = await runRollover();
  console.log(`[rollover] downgraded ${total} expired plan(s) to free`);
}

main().catch((e) => {
  console.error("[rollover] failed:", e);
  captureError(e, { script: "rollover" });
  process.exit(1);
});
