import { sendExpiryReminders } from "../lib/reminder";
import { initObservability, captureError } from "../lib/observability";

initObservability("remind");

async function main() {
  const sent = await sendExpiryReminders();
  console.log(`[remind] sent ${sent} credit-expiry reminder(s)`);
}

main().catch((e) => {
  console.error("[remind] failed:", e);
  captureError(e, { script: "remind" });
  process.exit(1);
});
