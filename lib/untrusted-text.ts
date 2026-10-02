// Quoting for text a stranger wrote, before it is placed next to anything the
// machine generated.
//
// It lives in its own module, not in lib/notify.ts where it started: lib/mail.ts
// needs it too, and mail.ts is imported (through lib/api.ts) on the Edge
// middleware path. Importing lib/notify.ts from there pulled lib/store.ts —
// undici, the SSRF-pinned agent, the whole provider HTTP stack — into the Edge
// runtime trace, which `next build` reports as extra "Node.js module is loaded"
// warnings for code the middleware never runs. A leaf module keeps that out.
export function quoteUntrusted(text: string): string {
  // Every line is prefixed, which is what makes this hold for ANY message
  // rather than for a list of dangerous lines that must be kept in sync: the
  // reporter's text is arbitrary and multi-line (newlines are the point of a
  // bug report), and both notification channels print it directly above a block
  // the operator triages from — the mail's `---`/`ref:`/`from: … (user <id>)`
  // context, the webhook's `[PixelDuo] 反馈 · …` header and `ref #…` trailer.
  // Unquoted, a message could reproduce those lines byte for byte and plant a
  // forgery naming somebody else's account above the real block.
  return text
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}
