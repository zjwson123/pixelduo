import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 60000,
  retries: 1,
  use: {
    baseURL: "http://localhost:3100",
    channel: process.env.PW_CHANNEL === "chrome" ? "chrome" : undefined,
    trace: "retain-on-failure",
  },
});
