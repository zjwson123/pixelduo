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

// Bound a string to `max` UTF-16 code units WITHOUT ever splitting a surrogate
// pair.
//
// `str.slice(0, n)` counts code units, so a cut landing between the two halves
// of an astral character — every emoji, every rare CJK extension glyph — returns
// a string ending in an unpaired high surrogate: ill-formed UTF-16 that no
// PostgreSQL text column can encode. Pass 31 found this twice on values that had
// ALREADY passed refuseNul (pass 30's guard): the guard validated the raw input,
// the slice then manufactured the very thing it refuses. On the query helpers
// (lib/api.ts's queryText) that meant Prisma InvalidArg → masked 500 + one
// captured incident per request on four routes; on the provider error text
// (lib/providers' errText) it meant failJob's Job.error write threw, so the
// attempt's real provider error, its reclaim and its retry/terminal decision
// were all lost. Only a trailing HIGH surrogate is stripped, because in
// well-formed input a low surrogate always follows its high half: the pair is
// either complete or the cut landed on the high one.
export function sliceCodePoints(value: string, max: number): string {
  return value.slice(0, max).replace(/[\uD800-\uDBFF]$/, "");
}
