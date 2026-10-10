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
  //
  // "Every line" has to mean every line a RENDERER sees, and the first version
  // only split on "\n" (pass 33): a bare `\r` returns a terminal cursor to
  // column 0, so it repainted the "> " prefix this function had just written,
  // and an ESC sequence (`\u001b[2K\u001b[1A` erases the line and steps UP) let
  // a message erase and rewrite the machine-generated `To:`/subject line above
  // it — the operator's log-only mailer (no SMTP_URL, or MAIL_DEV_MODE) prints
  // straight to the terminal, and the forgery arrived in the channel the
  // operator reads. U+2028/U+2029/U+0085 are line separators to many renderers
  // while being ordinary characters to a "\n"-only split, so text after one
  // began a fresh, unprefixed line. Both classes now behave: every separator
  // starts a new quoted line, and every remaining control character is replaced
  // with a space — the C1 block's 8-bit CSI (U+009B) among them, which opens an
  // escape sequence without ESC — so nothing can move the cursor.
  return text
    .split(LINE_SEPARATORS)
    .map((line) => `> ${line.replace(CONTROL_CHARS, " ")}`)
    .join("\n");
}

// Every character a renderer may treat as a line break while remaining a
// single character to a naive "\n"-only split: CR/CRLF, NEL (C1, reachable in
// an HTTP header value as byte 0x85), LINE SEPARATOR and PARAGRAPH SEPARATOR.
const LINE_SEPARATORS = /\r\n|[\n\r\u0085\u2028\u2029]/;

// C0 minus \t, \n and \r — the line breaks are handled by the split above, and
// a tab cannot move a cursor — plus DEL (some terminals map it to backspace)
// and the whole C1 block.
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;

// For a value interpolated UNQUOTED into a machine-generated line (`page:` in
// the operator mail's context block, `agent:` beside it, `from <page>` in the
// webhook line): it cannot be quoted line by line the way the message is,
// because it is not supposed to be multi-line at all. Everything a renderer
// could act on — line separators and every other control character, tab
// included — becomes a space, so the line it lands on stays exactly one
// machine-generated line, whatever the caller sent. Both builders apply it; the
// feedback route additionally REFUSES a `page` carrying these characters (a
// pathname has no legitimate one), while a User-Agent header is only
// sanitized — it cannot be refused, and dropping recon over a stray byte would
// cost more than it protects.
export function singleLine(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ");
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
