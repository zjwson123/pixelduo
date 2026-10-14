import { describe, expect, it } from "vitest";
import {
  verificationHtml,
  resetHtml,
  receiptHtml,
  refundHtml,
  expiryHtml,
} from "../lib/mail-html";

// The origin every template renders with here is deliberately NOT the vendor
// domain: pass 37 made it a required parameter (the bodies hard-coded
// https://pixelduo.ai, so a self-hosted deployment mailed its own users to a
// site the operator does not own), and one of the cases below pins that.
const ORIGIN = "https://app.example.com";

describe("HTML email templates", () => {
  it("verify link is present and branded", () => {
    const html = verificationHtml("https://pixelduo.ai/verify-email?token=abc", ORIGIN);
    expect(html).toContain("PixelDuo");
    expect(html).toContain("https://pixelduo.ai/verify-email?token=abc");
    expect(html).toContain("Verify my email");
  });

  it("reset link is present", () => {
    expect(resetHtml("https://pixelduo.ai/reset-password?token=xyz", ORIGIN)).toContain(
      "reset-password?token=xyz",
    );
  });

  it("receipt and refund carry the amount and item", () => {
    expect(receiptHtml("Pro plan", 19, 2000, ORIGIN)).toContain("$19.00");
    expect(receiptHtml("Pro plan", 19, 2000, ORIGIN)).toContain("Pro plan");
    expect(receiptHtml("Pro plan", 19, 2000, ORIGIN)).toContain("2000");
    expect(refundHtml("400 credits pack", 4.99, ORIGIN)).toContain("$4.99");
  });

  it("expiry email uses the day label", () => {
    expect(expiryHtml(3, 150, ORIGIN)).toContain("expire in 3 days");
    expect(expiryHtml(1, 150, ORIGIN)).toContain("expire tomorrow");
    expect(expiryHtml(1, 150, ORIGIN)).toContain("150 credits");
  });

  it("escapes user-supplied content", () => {
    const html = receiptHtml("<script>alert(1)</script>", 9.99, 100, ORIGIN);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  // Pass 37. Every link, and the host named in the footer, come from the
  // deployment's own origin — so a self-hosted instance never points its users
  // at the vendor's domain.
  it("renders every link against the origin it is given, not the vendor domain", () => {
    const bodies = [
      verificationHtml(`${ORIGIN}/verify-email?token=t`, ORIGIN),
      resetHtml(`${ORIGIN}/reset-password?token=t`, ORIGIN),
      receiptHtml("Starter plan", 9, 800, ORIGIN),
      refundHtml("400 credits pack", 4.99, ORIGIN),
      expiryHtml(2, 100, ORIGIN),
    ];
    for (const html of bodies) {
      expect(html).not.toContain("pixelduo.ai");
      expect(html).toContain(`${ORIGIN}/terms`);
      expect(html).toContain(`${ORIGIN}/privacy`);
      expect(html).toContain("app.example.com");
    }
    // The workbench button is origin-relative, and a trailing slash on the
    // origin does not double up.
    expect(expiryHtml(2, 100, `${ORIGIN}/`)).toContain(`${ORIGIN}/studio`);
    expect(expiryHtml(2, 100, `${ORIGIN}/`)).not.toContain(`${ORIGIN}//studio`);
  });
});
