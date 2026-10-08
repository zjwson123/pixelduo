import { sendExpiryReminders } from "../lib/reminder";
import { assertDatabaseSessionUtc } from "../lib/prisma";
import { initObservability, captureError } from "../lib/observability";

initObservability("remind");

async function main() {
  // The mail says "N days left", a claim about the deadline the spend path reads
  // in SQL — see lib/prisma.ts's pin for why the session must be UTC.
  await assertDatabaseSessionUtc();
  const sent = await sendExpiryReminders();
  console.log(`[remind] sent ${sent} credit-expiry reminder(s)`);
}

main().catch((e) => {
  console.error("[remind] failed:", e);
  captureError(e, { script: "remind" });
  process.exit(1);
});
