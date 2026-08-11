import { runRollover } from "../lib/rollover";
import { initObservability, captureError } from "../lib/observability";

initObservability("rollover");

async function main() {
  const total = await runRollover();
  console.log(`[rollover] downgraded ${total} expired plan(s) to free`);
}

main().catch((e) => {
  console.error("[rollover] failed:", e);
  captureError(e, { script: "rollover" });
  process.exit(1);
});
