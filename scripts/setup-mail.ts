// Configure outbound mail in one command, then prove it works.
//
//   npx tsx scripts/setup-mail.ts aliyun no-reply@yourdomain.com <password>
//   npx tsx scripts/setup-mail.ts resend <api-key> "PixelDuo <no-reply@yourdomain.com>"
//   npx tsx scripts/setup-mail.ts local 2525            # verify the path with no provider
//
// Writes SMTP_URL + EMAIL_FROM into .env (after backing it up), then runs the
// delivery check from scripts/verify-mail.ts and prints what the receiving
// server answered. The credential is written to .env and never printed.
import fs from "fs";
import path from "path";
import { MAIL_PRESETS, findPreset, schemeForPort } from "../lib/mail-presets";

const [providerId, ...rest] = process.argv.slice(2);

function usage(exitCode = 1): never {
  console.error("usage: npx tsx scripts/setup-mail.ts <provider> <credential|port> [from-address]");
  console.error("\nproviders:");
  for (const p of MAIL_PRESETS) {
    console.error(`  ${p.id.padEnd(9)} ${p.label}`);
    if (p.notes) console.error(`            ${p.notes}`);
  }
  console.error("\nexample: npx tsx scripts/setup-mail.ts aliyun no-reply@example.com <password>");
  process.exit(exitCode);
}

if (!providerId) usage();
const preset = findPreset(providerId);
if (!preset) {
  console.error(`unknown provider '${providerId}'`);
  usage();
}

// Argument shape differs per provider: address-first for mailbox providers,
// credential-first for token providers, a PORT for the local sink.
const args = rest.filter((a) => a !== "");
const portFirst = preset.needs[0] === "port";
const addressFirst = preset.needs[0] === "address";
const address = portFirst ? args[0] : addressFirst ? args[0] : preset.id === "ses" ? args[1] : undefined;
const credential = portFirst ? "" : addressFirst ? args[1] : args[0];
const fromArg = portFirst ? undefined : addressFirst ? args[2] : args[1];

if (!address && !credential) usage();
if (portFirst ? !address : !credential) {
  console.error(`missing ${addressFirst && !address ? "address" : "credential"}`);
  usage();
}

const region = process.env.AWS_REGION;
const smtpUrl = preset.build({ credential, address, region });
// For a mailbox provider the From is the mailbox itself unless overridden; for
// the local sink it must be the preset's placeholder (the "address" there is a
// port number, which is not a mailbox).
const emailFrom = fromArg || process.env.EMAIL_FROM || (addressFirst ? address! : preset.fromHint);

// Scheme sanity: catch the 465/587 mismatch before it becomes a hang.
const port = Number(new URL(smtpUrl.replace(/^smtps:/, "http:")).port || 0);
if (port === 465 && !smtpUrl.startsWith("smtps://")) {
  console.error(`refusing to write: port 465 needs smtps:// (got ${smtpUrl.slice(0, 12)}…)`);
  process.exit(1);
}
if (port !== 465 && smtpUrl.startsWith("smtps://")) {
  console.error(`refusing to write: smtps:// is for port 465 (implicit TLS); use ${schemeForPort(port)}:// for ${port}`);
  process.exit(1);
}

// Write .env, touching only the two keys (idempotent, with a backup).
const envPath = path.resolve(process.cwd(), ".env");
const existing = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
if (existing) fs.writeFileSync(`${envPath}.bak`, existing);
const kept = existing
  .split("\n")
  .filter((line) => !/^\s*(SMTP_URL|EMAIL_FROM)\s*=/.test(line))
  .join("\n")
  .replace(/\n+$/, "");
const next = `${kept ? `${kept}\n` : ""}SMTP_URL="${smtpUrl}"\nEMAIL_FROM="${emailFrom}"\n`;
fs.chmodSync(envPath, 0o600);
fs.writeFileSync(envPath, next);

const masked = (s: string) => (s.length > 8 ? `${s.slice(0, 4)}…(${s.length} chars)` : "…");
// Mask the whole userinfo segment — it may itself contain '@' (mailbox
// providers authenticate as the address), so a naive first-'@' match garbles
// the display of a perfectly valid URL.
const shownUrl = smtpUrl.replace(/^([a-z]+:\/\/).*@([^@]*)$/, (_, scheme: string, host: string) =>
  `${scheme}${masked(credential)}@${host}`,
);
console.log(`wrote ${envPath}${existing ? ` (backup: ${envPath}.bak)` : ""}`);
console.log(`  SMTP_URL   = ${shownUrl}`);
console.log(`  EMAIL_FROM = ${emailFrom}`);
console.log(`  provider   = ${preset.label}`);
if (preset.notes) console.log(`  note       = ${preset.notes}`);

if (preset.id === "local") {
  console.log("\nNothing will reach a real mailbox with the local sink — it only proves the path.");
}

// Then prove it, in this same process, using the values we just wrote.
// (Wrapped, not top-level await: package.json has no "type": "module", so tsx
// compiles these scripts to CJS, where top-level await is a syntax error.)
async function main() {
  process.env.SMTP_URL = smtpUrl;
  process.env.EMAIL_FROM = emailFrom;
  const { checkDelivery, describeMailFailure } = await import("../lib/mail-check");
  const result = await checkDelivery();
  if (result.ok) {
    console.log(`notification → ${result.recipient}`);
    console.log(`  server response: ${result.response ?? "(none reported)"}`);
    console.log("\n[OK] the receiving server accepted the notification.");
    process.exit(0);
  }
  console.error(`\n[FAIL] ${result.error ?? "delivery failed"}`);
  const hint = describeMailFailure(result.error ?? "");
  if (hint) console.error(`       ${hint}`);
  console.error("       Values were written to .env; fix them (or re-run this script) and run npx tsx scripts/verify-mail.ts again.");
  process.exit(1);
}

void main();
