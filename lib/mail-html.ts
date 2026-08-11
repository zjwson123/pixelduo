// Branded HTML email templates (inline styles, email-client friendly).

function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function wrap(title: string, body: string): string {
  return `<!doctype html><html><body style="margin:0;padding:0;background:#f4f5f7;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;padding:24px 0"><tr><td align="center">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 6px 24px rgba(20,30,60,.08)">
<tr><td style="background:#111827;color:#ffffff;padding:22px 28px"><span style="font-size:18px;font-weight:700">PixelDuo</span><span style="float:right;font-size:12px;opacity:.75">Two models. One prompt.</span></td></tr>
<tr><td style="padding:28px;color:#1f2430;font-size:14px;line-height:1.65">${body}</td></tr>
<tr><td style="padding:16px 28px;border-top:1px solid #eef0f4;color:#8a90a3;font-size:12px">
PixelDuo · pixelduo.ai · <a href="https://pixelduo.ai/terms" style="color:#8a90a3">Terms</a> · <a href="https://pixelduo.ai/privacy" style="color:#8a90a3">Privacy</a>
</td></tr>
</table></td></tr></table></body></html>`;
}

function button(href: string, label: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:18px 0"><tr><td style="background:#4338f7;border-radius:10px;padding:12px 22px"><a href="${esc(href)}" style="color:#ffffff;text-decoration:none;font-weight:600">${esc(label)}</a></td></tr></table>`;
}

export function verificationHtml(link: string): string {
  return wrap(
    "Verify your email",
    `<h1 style="margin:0 0 10px;font-size:20px">Welcome to PixelDuo</h1>
<p style="margin:0 0 14px">Confirm your email address to activate your <b>30 free credits</b> and start creating.</p>
${button(link, "Verify my email")}
<p style="margin:0;color:#8a90a3;font-size:12px">Or paste this link: ${esc(link)}<br/>The link expires in 24 hours. If you didn't create this account, you can safely ignore this email.</p>`,
  );
}

export function resetHtml(link: string): string {
  return wrap(
    "Reset your password",
    `<h1 style="margin:0 0 10px;font-size:20px">Reset your password</h1>
<p style="margin:0 0 14px">We received a request to reset your PixelDuo password. Use the button below to choose a new one.</p>
${button(link, "Reset password")}
<p style="margin:0;color:#8a90a3;font-size:12px">Or paste this link: ${esc(link)}<br/>The link expires in 1 hour. If you didn't request this, you can safely ignore this email.</p>`,
  );
}

export function receiptHtml(itemName: string, amountUsd: number, credits: number): string {
  return wrap(
    "Your receipt",
    `<h1 style="margin:0 0 10px;font-size:20px">Thank you for your purchase</h1>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:14px 0">
<tr><td style="padding:8px 0;border-bottom:1px solid #eef0f4;color:#8a90a3">Item</td><td style="padding:8px 0;border-bottom:1px solid #eef0f4;text-align:right">${esc(itemName)}</td></tr>
<tr><td style="padding:8px 0;border-bottom:1px solid #eef0f4;color:#8a90a3">Amount</td><td style="padding:8px 0;border-bottom:1px solid #eef0f4;text-align:right;font-weight:600">$${amountUsd.toFixed(2)}</td></tr>
<tr><td style="padding:8px 0;color:#8a90a3">Credits added</td><td style="padding:8px 0;text-align:right;font-weight:600">${credits}</td></tr>
</table>
<p style="margin:0;color:#8a90a3;font-size:12px">You can view your order history any time in the workbench.</p>`,
  );
}

export function refundHtml(itemName: string, amountUsd: number): string {
  return wrap(
    "Your refund",
    `<h1 style="margin:0 0 10px;font-size:20px">We processed your refund</h1>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:14px 0">
<tr><td style="padding:8px 0;border-bottom:1px solid #eef0f4;color:#8a90a3">Item</td><td style="padding:8px 0;border-bottom:1px solid #eef0f4;text-align:right">${esc(itemName)}</td></tr>
<tr><td style="padding:8px 0;color:#8a90a3">Refunded amount</td><td style="padding:8px 0;text-align:right;font-weight:600">$${amountUsd.toFixed(2)}</td></tr>
</table>
<p style="margin:0;color:#8a90a3;font-size:12px">The refund may take a few business days to appear on your statement.</p>`,
  );
}

export function expiryHtml(daysLeft: number, credits: number): string {
  const label = daysLeft <= 1 ? "tomorrow" : `in ${daysLeft} days`;
  return wrap(
    "Credits expiring soon",
    `<h1 style="margin:0 0 10px;font-size:20px">Your credits expire ${label}</h1>
<p style="margin:0 0 14px">You have <b>${credits} credits</b> expiring ${label}. Use them before they're gone — or top up now to keep creating.</p>
${button("https://pixelduo.ai/studio", "Open the workbench")}`,
  );
}
