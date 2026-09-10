import { describe, expect, it } from "vitest";
import { fetchPublicBuffer } from "../lib/store";

// SSRF guard for provider-returned URLs. The internal-address cases need no
// network (string/literal short-circuits); the port case needs one public
// DNS resolution, which CI (an online runner) provides.
describe("fetchPublicBuffer guard", () => {
  it("blocks internal hostnames before any connection", async () => {
    await expect(fetchPublicBuffer("http://localhost:9/x", { timeoutMs: 1000, maxBytes: 10 })).rejects.toThrow(
      "blocked-internal-url",
    );
  });

  it("blocks inet_aton-style internal literals", async () => {
    // 2130706433 = 127.0.0.1 in decimal; 0x7f.1 = 127.0.0.1
    await expect(fetchPublicBuffer("http://2130706433:9/x", { timeoutMs: 1000, maxBytes: 10 })).rejects.toThrow(
      "blocked-internal-url",
    );
    await expect(fetchPublicBuffer("http://0x7f.1:9/x", { timeoutMs: 1000, maxBytes: 10 })).rejects.toThrow(
      "blocked-internal-url",
    );
  });

  it("blocks non-web ports on public hosts (no port probing)", async () => {
    await expect(
      fetchPublicBuffer("http://example.com:6379/x", { timeoutMs: 3000, maxBytes: 10 }),
    ).rejects.toThrow("blocked-port");
    await expect(
      fetchPublicBuffer("https://example.com:8080/x", { timeoutMs: 3000, maxBytes: 10 }),
    ).rejects.toThrow("blocked-port");
  });

  it("rejects non-http(s) schemes outright", async () => {
    await expect(fetchPublicBuffer("file:///etc/passwd", { timeoutMs: 1000, maxBytes: 10 })).rejects.toThrow(
      "invalid-url-scheme",
    );
  });
});
