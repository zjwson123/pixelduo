import { describe, expect, it } from "vitest";
import {
  verificationHtml,
  resetHtml,
  receiptHtml,
  refundHtml,
  expiryHtml,
} from "../lib/mail-html";

describe("HTML email templates", () => {
  it("verify link is present and branded", () => {
    const html = verificationHtml("https://pixelduo.ai/verify-email?token=abc");
    expect(html).toContain("PixelDuo");
    expect(html).toContain("https://pixelduo.ai/verify-email?token=abc");
    expect(html).toContain("Verify my email");
  });

  it("reset link is present", () => {
    expect(resetHtml("https://pixelduo.ai/reset-password?token=xyz")).toContain("reset-password?token=xyz");
  });

  it("receipt and refund carry the amount and item", () => {
    expect(receiptHtml("Pro plan", 19, 2000)).toContain("$19.00");
    expect(receiptHtml("Pro plan", 19, 2000)).toContain("Pro plan");
    expect(receiptHtml("Pro plan", 19, 2000)).toContain("2000");
    expect(refundHtml("400 credits pack", 4.99)).toContain("$4.99");
  });

  it("expiry email uses the day label", () => {
    expect(expiryHtml(3, 150)).toContain("expire in 3 days");
    expect(expiryHtml(1, 150)).toContain("expire tomorrow");
    expect(expiryHtml(1, 150)).toContain("150 credits");
  });

  it("escapes user-supplied content", () => {
    const html = receiptHtml("<script>alert(1)</script>", 9.99, 100);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});
