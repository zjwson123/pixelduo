import { runExpiry } from "../lib/expiry";
import { purgeExpiredTokens } from "../lib/tokens";
import { initObservability, captureError } from "../lib/observability";

initObservability("expire");

async function main() {
  const expired = await runExpiry();
  const tokens = await purgeExpiredTokens();
  console.log(`[expire] expired credits: ${expired}, purged tokens: ${tokens}`);
}

main().catch((e) => {
  console.error("[expire] failed:", e);
  captureError(e, { script: "expire" });
  process.exit(1);
});
