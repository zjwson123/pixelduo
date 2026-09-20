import Link from "next/link";

export const metadata = { title: "Privacy Policy — PixelDuo" };

export default function PrivacyPage() {
  return (
    <div className="legal">
      <div className="legal-card">
        <p className="legal-kicker"><Link href="/">PixelDuo</Link></p>
        <h1>Privacy Policy</h1>
        <p className="legal-meta">v0.1 · Effective before commercial launch</p>

        <h2>What we collect</h2>
        <ul>
          <li><b>Account</b> — email, password hash, display name.</li>
          <li><b>Usage</b> — generation records (prompts, model, credits), ledger entries, orders. Card details are handled by payment providers; we never store card numbers.</li>
          <li><b>Technical</b> — IP and device/browser data for security and rate limiting.</li>
          <li><b>Feedback you send</b> — your message, the reply address, and (to make the report actionable) your plan, interface language, the page you sent it from and your browser's user-agent string. A copy is emailed to our support inbox so we can answer you there.</li>
        </ul>

        <h2>How we use it</h2>
        <p>To provide and improve the service (generation, billing, support), prevent abuse and fraud (rate limits, risk controls), and meet legal obligations (financial/tax records, lawful requests).</p>

        <h2>Storage &amp; security</h2>
        <p>Passwords are bcrypt-hashed; sessions use HttpOnly secure cookies. Data and images are stored in controlled cloud environments, transferred over TLS, and images are private by default — only you can access your own images.</p>

        <h2>Your rights (GDPR / PIPL)</h2>
        <ul>
          <li><b>Export</b> — request all your data via the account export feature.</li>
          <li><b>Delete</b> — request account and related data deletion; feedback you sent while signed in is removed with the account.</li>
          <li><b>Correct / withdraw / complain</b> — contact support@pixelduo.ai, or send us a message from the <Link href="/feedback">feedback page</Link> (works whether or not you can sign in).</li>
        </ul>

        <h2>Retention</h2>
        <p>Account data is removed within 30 days of a deletion request (except where law requires retention, e.g. tax records). Logs are retained no longer than 12 months.</p>

        <h2>Children</h2>
        <p>The service is for users 13 and older; generating realistic likenesses of real people requires being 18+. Child sexual abuse material is reported to authorities and removed.</p>

        <h2>Contact</h2>
        <p>
          Data protection contact: support@pixelduo.ai — or use the <Link href="/feedback">feedback page</Link>, which
          reaches us without needing to sign in.
        </p>

        <p className="legal-back"><Link href="/">← Back to PixelDuo</Link></p>
      </div>
    </div>
  );
}
