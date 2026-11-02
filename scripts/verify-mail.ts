// Pre-flight delivery check for the feedback notification.
//
//   SMTP_URL="smtp://resend:<API_KEY>@smtp.resend.com:587" \
//   EMAIL_FROM="PixelDuo <no-reply@yourdomain>" \
//   npx tsx scripts/verify-mail.ts [recipient]
//
// Sends the REAL feedback notification (the same payload POST /api/feedback
// produces, via the app's own mailer) and prints what the receiving server
// answered. A 250 with a queued id is proof the operator's mailbox accepted it;
// "no error in our logs" is not, and neither is a DevMailer line — which is why
// this exists: without SMTP_URL the app prints mail instead of sending it, and
// nothing in the app surfaces that difference (see mailDeliverable()).
//
// Exit code is 0 only when the transport reported success, so it is usable as a
// deploy gate. Use scripts/setup-mail.ts to write the .env values first.
import { checkDelivery, describeMailFailure, maskSecretUrl } from "../lib/mail-check";
import { feedbackMailRefusal, feedbackRecipient, mailDeliverable } from "../lib/mail";

async function main() {
  const recipient = process.argv[2] || feedbackRecipient();

  // Masked, not verbatim: SMTP_URL's userinfo IS the SMTP password, and the
  // admin console's failure banner tells the operator to run this script and
  // relay what it printed (see maskSecretUrl for the whole reasoning).
  console.log(`transport:  ${mailDeliverable() ? maskSecretUrl(process.env.SMTP_URL) : "(none — log-only DevMailer)"}`);
  console.log(`from:       ${process.env.EMAIL_FROM || "(default)"}`);
  console.log(`recipient:  ${recipient}`);
  console.log(`feedback to: ${feedbackRecipient()}`);

  const result = await checkDelivery({ recipient });
  if (result.ok) {
    console.log(`notification → ${result.recipient}`);
    console.log(`  server response: ${result.response ?? "(none reported)"}`);
    if (result.messageId) console.log(`  message id:      ${result.messageId}`);
    console.log("\n[OK] the receiving server accepted the notification — check the inbox (and spam) for two messages.");
    process.exit(0);
  }

  console.error(`\n[FAIL] ${result.error ?? "delivery failed"}`);
  if (feedbackMailRefusal()) {
    // A deployment that never named a recipient cannot be validated by this
    // script, and pretending otherwise would hide the misconfiguration it is
    // meant to catch.
    console.error(
      "       Nothing is wrong with the SMTP settings themselves — but production refuses to notify\n" +
        "       the built-in default address. Name the mailbox your team reads, then re-run:\n" +
        '       FEEDBACK_TO="support@yourdomain.com" npx tsx scripts/verify-mail.ts',
    );
  } else if (!mailDeliverable()) {
    console.error(
      "       Set SMTP_URL + EMAIL_FROM (docs/deploy.md has the provider list) and re-run, or:\n" +
        "       read -s SMTP_CREDENTIAL; export SMTP_CREDENTIAL\n" +
        "       npx tsx scripts/setup-mail.ts <provider> [address] [from-address]\n" +
        "       (the credential goes through the environment, never argv — an argv credential\n" +
        "       lands in shell history and is readable through ps for the whole run)\n" +
        "       To exercise the transport with no provider account: node scripts/dev-smtp-sink.mjs 2525 &\n" +
        "       then npx tsx scripts/setup-mail.ts local 2525",
    );
  } else {
    const hint = describeMailFailure(result.error ?? "");
    if (hint) console.error(`       ${hint}`);
  }
  process.exit(1);
}

void main();
