import Link from "next/link";

export const metadata = { title: "Terms of Service — PixelDuo" };

export default function TermsPage() {
  return (
    <div className="legal">
      <div className="legal-card">
        <p className="legal-kicker"><Link href="/">PixelDuo</Link></p>
        <h1>Terms of Service</h1>
        <p className="legal-meta">v0.1 · Effective before commercial launch</p>

        <h2>1. Service</h2>
        <p>PixelDuo provides AI image generation, a prompt assistant, templates and a gallery as online tools.</p>

        <h2>2. Accounts</h2>
        <p>You must provide accurate registration information. Accounts may not be resold, and you are responsible for all activity under your account.</p>

        <h2>3. Credits &amp; subscriptions</h2>
        <p>Credits and subscriptions are virtual allowances usable only within the platform. Purchased credits are valid for 12 months; unused monthly subscription quota carries over at 30% for the following month only. The service is in beta and features or prices may change. Payments, where enabled, are processed by our payment provider: the amount and currency shown on that provider&apos;s checkout page are the ones that apply, and nothing is charged where a deployment runs without a payment provider configured.</p>

        <h2>4. Generated content &amp; IP</h2>
        <p>You keep commercial rights to images generated from your prompts, provided the content is lawful and compliant. You warrant that your inputs do not infringe third-party rights (likeness, trademark, copyright). The platform may remove content that violates these terms or our safety policy.</p>

        <h2>5. Prohibited use</h2>
        <p>Do not generate or distribute illegal, sexual, violent, child-exploitative, hateful, weapon-instruction, or otherwise policy-violating content. The platform is strictly SFW.</p>

        <h2>6. AI labeling</h2>
        <p>Generated content is labeled as AI-generated where required by applicable law. You may not remove platform-applied labels.</p>

        <h2>7. Refunds</h2>
        <p>Unused credit balances may be refundable within a 14-day cooling-off period; images already generated are not refundable. Refunds follow then-current platform rules.</p>

        <h2>8. Availability &amp; liability</h2>
        <p>The service is provided “as is”. The platform is not liable for indirect losses from upstream model outages, network issues or force majeure. To the extent permitted by law, total liability is limited to amounts paid in the previous 12 months.</p>

        <h2>9. Changes</h2>
        <p>We will announce material changes to these terms in advance; continued use constitutes acceptance.</p>

        <p className="legal-back"><Link href="/">← Back to PixelDuo</Link></p>
      </div>
    </div>
  );
}
