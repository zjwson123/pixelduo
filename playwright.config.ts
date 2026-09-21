import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 60000,
  retries: 1,
  use: {
    // The verification-flow pass runs its own app instance on its own port
    // (scripts/ci-local.sh), because the two EMAIL_VERIFY_AUTO modes cannot
    // share one process.
    baseURL: process.env.PW_BASE_URL ?? "http://localhost:3100",
    channel: process.env.PW_CHANNEL === "chrome" ? "chrome" : undefined,
    trace: "retain-on-failure",
  },
});
