import { runExpiry } from "../lib/expiry";
import { purgeExpiredTokens } from "../lib/tokens";
import { assertDatabaseSessionUtc } from "../lib/prisma";
import { initObservability, captureError } from "../lib/observability";

initObservability("expire");

async function main() {
  // This is the pass that DESTROYS expired credits, judging `expiresAt <= now()`
  // in SQL: against a session on local time it would zero grants hours early
  // (see lib/prisma.ts's pin). Refuse to run instead.
  await assertDatabaseSessionUtc();
  const expired = await runExpiry();
  const tokens = await purgeExpiredTokens();
  console.log(`[expire] expired credits: ${expired}, purged tokens: ${tokens}`);
}

main().catch((e) => {
  console.error("[expire] failed:", e);
  captureError(e, { script: "expire" });
  process.exit(1);
});
