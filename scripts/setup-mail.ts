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
import { maskSecretUrl } from "../lib/mail-check";
import { feedbackMailRefusal } from "../lib/mail";

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
//
// Refuse inside a container: docs/server-setup.md tells operators to run the
// scripts from the worker image (`docker compose exec worker npx tsx …`), and
// there `process.cwd()` is the image's /app — the write lands in the container's
// writable layer, the running web/worker keep their original environment, and
// the script exits 0 printing "wrote /app/.env" and a delivery-verified result.
// Nothing reaches the deployment, and the ephemeral file disappears with the
// next `up --build`. Better to fail loudly and name the two variables to set on
// the host.
if (fs.existsSync("/.dockerenv")) {
  console.error(
    [
      "refusing to write .env: this is running INSIDE a container, where the file would be",
      "written to the image's ephemeral layer and never reach the running services.",
      "",
      "Set these on the HOST instead (e.g. in the .env that docker compose reads):",
      `  SMTP_URL="${smtpUrl}"`,
      `  EMAIL_FROM="${emailFrom}"`,
      "",
      "Then recreate the containers: docker compose up -d --force-recreate web worker",
    ].join("\n"),
  );
  process.exit(1);
}
const envPath = path.resolve(process.cwd(), ".env");
const existing = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
// The backup gets the SAME restrictive mode as .env, and that has to be set at
// creation: it holds every secret the previous file did (NEXTAUTH_SECRET,
// DATABASE_URL, provider keys), and `writeFileSync` would otherwise create it
// world-readable (0666 & ~umask) next to a 0600 .env — the one copy of the
// session-signing key that any local account could read, and a forged session
// is not something the production boot gate can catch.
if (existing) fs.writeFileSync(`${envPath}.bak`, existing, { mode: 0o600 });
const kept = existing
  .split("\n")
  .filter((line) => !/^\s*(SMTP_URL|EMAIL_FROM)\s*=/.test(line))
  .join("\n")
  .replace(/\n+$/, "");
const next = `${kept ? `${kept}\n` : ""}SMTP_URL="${smtpUrl}"\nEMAIL_FROM="${emailFrom}"\n`;
fs.chmodSync(envPath, 0o600);
fs.writeFileSync(envPath, next);

// Masked by the shared helper, not by a local copy: the credential in this URL
// is the same secret scripts/verify-mail.ts prints, and two masking routines
// meant two answers to "is this output safe to paste into a ticket" (this one
// showed the first 4 characters of the password).
const shownUrl = maskSecretUrl(smtpUrl);
console.log(`wrote ${envPath}${existing ? ` (backup: ${envPath}.bak)` : ""}`);
console.log(`  SMTP_URL   = ${shownUrl}`);
console.log(`  EMAIL_FROM = ${emailFrom}`);
console.log(`  provider   = ${preset.label}`);
if (preset.notes) console.log(`  note       = ${preset.notes}`);
// This script owns SMTP_URL/EMAIL_FROM only; a feedback mail still needs a
// recipient, and production refuses the built-in default rather than mailing a
// user's message to whoever wrote the code.
if (!process.env.FEEDBACK_TO) {
  console.log(
    "  FEEDBACK_TO is not set — add FEEDBACK_TO=\"support@yourdomain.com\" to .env and export it here,\n" +
      "  or the delivery check below (and every production feedback notification) is refused.",
  );
}

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
  if (feedbackMailRefusal()) {
    console.error(
      "       SMTP_URL and EMAIL_FROM are written and may be perfectly good — but with FEEDBACK_TO unset a\n" +
        "       production deployment refuses to send user feedback anywhere, and this check now says so.\n" +
        '       Add FEEDBACK_TO="support@yourdomain.com" to .env (and export it in this shell — these\n' +
        "       scripts read the environment, not the file) and re-run npx tsx scripts/verify-mail.ts.",
    );
  } else {
    const hint = describeMailFailure(result.error ?? "");
    if (hint) console.error(`       ${hint}`);
  }
  console.error("       Values were written to .env; fix them (or re-run this script) and run npx tsx scripts/verify-mail.ts again.");
  process.exit(1);
}

void main();
