import { describe, expect, it } from "vitest";
import { MAIL_PRESETS, findPreset, schemeForPort } from "../lib/mail-presets";
import { describeMailFailure } from "../lib/mail-check";

// The setup script composes SMTP URLs by hand, which is where the two classic
// first-run failures come from: a 465 port spelled smtp:// (STARTTLS on a
// TLS-only port just hangs) and a mailbox address used as the username, whose
// '@' makes the userinfo ambiguous. Both are asserted here rather than in prose.
describe("mail provider presets", () => {
  it("builds a URL whose parts survive the parser nodemailer uses", () => {
    for (const preset of MAIL_PRESETS) {
      const url = preset.build({ credential: "s3cr3t", address: "me@example.com", region: "eu-west-1" });
      const parsed = new URL(url);
      // The checks below are the ones that decide whether a real send works.
      expect(parsed.protocol === "smtp:" || parsed.protocol === "smtps:", `${preset.id}: ${url}`).toBe(true);
      expect(parsed.hostname.length).toBeGreaterThan(0);
      expect(parsed.port.length).toBeGreaterThan(0);
      // The local sink is deliberately unauthenticated, so only a preset that
      // declares a credential has to carry one through the URL.
      if (preset.needs.includes("credential")) {
        expect(decodeURIComponent(parsed.password), `${preset.id} password`).toBe("s3cr3t");
        expect(decodeURIComponent(parsed.username).length, `${preset.id} username`).toBeGreaterThan(0);
      }
    }
  });

  it("keeps the mailbox address intact as the username", () => {
    // Exactly the case a hand-written URL gets wrong: the address contains '@'.
    const url = findPreset("gmail")!.build({ credential: "app-password", address: "zjw@example.com" });
    const parsed = new URL(url);
    expect(decodeURIComponent(parsed.username)).toBe("zjw@example.com");
    expect(decodeURIComponent(parsed.password)).toBe("app-password");
    expect(parsed.hostname).toBe("smtp.gmail.com");
  });

  it("pairs the TLS scheme with the port, for every preset", () => {
    for (const preset of MAIL_PRESETS) {
      const url = preset.build({ credential: "c", address: "a@b.com", region: "us-east-1" });
      const port = Number(new URL(url).port);
      // schemeForPort is the rule the setup script enforces before writing .env.
      expect(url.startsWith(`${schemeForPort(port)}://`), `${preset.id} → ${url}`).toBe(true);
      if (port === 465) expect(url.startsWith("smtps://")).toBe(true);
    }
  });

  it("documents every provider with a credential requirement", () => {
    for (const preset of MAIL_PRESETS) {
      expect(preset.label.length).toBeGreaterThan(0);
      expect(preset.fromHint.length).toBeGreaterThan(0);
      expect(preset.needs.length).toBeGreaterThan(0);
    }
  });
});

describe("mail failure hints", () => {
  it("maps the failures an operator actually hits", () => {
    // Each of these cost somebody a first run: credential type, sender domain,
    // socket/TLS pairing, provider sandbox quota.
    expect(describeMailFailure("535 5.7.8 Username and Password not accepted")).toMatch(/APP PASSWORD|授权码/);
    expect(describeMailFailure("553 5.7.2 Sender address rejected: domain is not verified")).toMatch(/verify the sending domain/i);
    expect(describeMailFailure("connect ETIMEDOUT 1.2.3.4:465")).toMatch(/465|587/);
    expect(describeMailFailure("wrong version number")).toMatch(/465|587/);
    expect(describeMailFailure("421 4.7.0 Daily message quota exceeded")).toMatch(/quota|sandbox/i);
    expect(describeMailFailure("No recipients defined")).toMatch(/recipient/i);
    // An unmapped error stays unmapped rather than producing a wrong guess.
    expect(describeMailFailure("something nobody has seen")).toBeNull();
  });
});
