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
// deploy gate.
import { getMailer, feedbackRecipient, mailDeliverable, sendFeedbackEmailWithReceipt } from "../lib/mail";

const recipient = process.argv[2] || feedbackRecipient();
const from = process.env.EMAIL_FROM || "PixelDuo <no-reply@pixelduo.ai>";

function hint(error: string): string | null {
  if (/535|535-5\.7\.8|Username and Password not accepted|Invalid login/i.test(error)) {
    return "Authentication rejected. Gmail requires an APP PASSWORD (2FA on, then https://myaccount.google.com/apppasswords); most providers reject a plain account password.";
  }
  if (/PBL|Spamhaus|blacklist|5\.7\.1/i.test(error)) {
    return "The sending IP is blocklisted (SES/Resend exist for exactly this reason). Use a provider's relay, not a bare IP.";
  }
  // The most common first-run failure at Resend/SES/SendGrid: the transport
  // authenticates fine and the message is refused because EMAIL_FROM's domain
  // has not been verified (with its SPF/DKIM records) in the provider console.
  if (/not verified|domain is not verified|not authorized to send|553|5\.7\.2|Sender address rejected|not allowed to send/i.test(error)) {
    return "The provider refuses EMAIL_FROM's domain. Verify the sending domain (Resend/SES/SendGrid all require it) and add its SPF + DKIM DNS records; until then use the provider's own onboarding address as EMAIL_FROM.";
  }
  if (/421|rate limit|too many|Daily message quota|5\.4\.5/i.test(error)) {
    return "The provider accepted the connection but refused this message (quota/rate limit, or a sandbox account restricted to its own address). Check the provider's dashboard.";
  }
  if (/ETIMEDOUT|ECONNREFUSED|ENOTFOUND|getaddrinfo/i.test(error)) {
    return "Could not reach the SMTP host — check the URL's host/port (587 + STARTTLS is the common pair) and outbound firewall rules.";
  }
  if (/self.signed|SSL|TLS|certificate/i.test(error)) {
    return "TLS problem — try port 587 (STARTTLS) instead of 465 (implicit TLS), or the reverse.";
  }
  return null;
}

async function main() {
  console.log(`transport:  ${mailDeliverable() ? process.env.SMTP_URL : "(none — log-only DevMailer)"}`);
  console.log(`from:       ${from}`);
  console.log(`recipient:  ${recipient}`);
  console.log(`feedback to: ${feedbackRecipient()}`);

  if (!mailDeliverable()) {
    console.error(
      "\n[FAIL] SMTP_URL is not set, so mail goes to the server log instead of a mailbox.\n" +
        "       Set SMTP_URL + EMAIL_FROM (docs/deploy.md has Resend / SES / Gmail recipes) and re-run.\n" +
        "       To exercise the transport with no provider account: node scripts/dev-smtp-sink.mjs 2525 & then SMTP_URL=smtp://127.0.0.1:2525 npx tsx scripts/verify-mail.ts",
    );
    process.exit(1);
  }

  // The handshake alone catches bad credentials/TLS before spending a message.
  try {
    await getMailer().send(
      recipient,
      "[PixelDuo] mail deliverability check",
      "This is the pre-flight check from scripts/verify-mail.ts. If you are reading it, PixelDuo can deliver mail.",
    );
    console.log("handshake+send: ok");
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`\n[FAIL] ${message}`);
    const h = hint(message);
    if (h) console.error(`       ${h}`);
    process.exit(1);
  }

  // Then the real payload, so the check covers the notification an operator
  // actually receives (subject, context block, Reply-To).
  try {
    const receipt = await sendFeedbackEmailWithReceipt({
      ref: "verify-mail",
      category: "other",
      message: "Pre-flight delivery check from scripts/verify-mail.ts — no action needed.",
      email: "verify-mail@pixelduo.ai",
      page: "/scripts/verify-mail",
      locale: "en",
      userAgent: "scripts/verify-mail.ts",
    });
    console.log(`notification → ${feedbackRecipient()}`);
    console.log(`  server response: ${receipt.response ?? "(none reported)"}`);
    if (receipt.messageId) console.log(`  message id:      ${receipt.messageId}`);
    if (receipt.rejected?.length) {
      console.error(`\n[FAIL] the server rejected: ${receipt.rejected.join(", ")}`);
      process.exit(1);
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`\n[FAIL] the feedback notification could not be sent: ${message}`);
    const h = hint(message);
    if (h) console.error(`       ${h}`);
    process.exit(1);
  }

  console.log("\n[OK] the receiving server accepted the notification — check the inbox (and spam) for two messages.");
}

void main();
