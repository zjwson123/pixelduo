// Provider errors that retries can never fix (auth, key restrictions,
// delisted models, and any failure to DOWNLOAD the artifact the provider
// returned). Failing these terminally refunds the user in seconds instead of
// after 3 rounds of backoff.
//
// The download class matters for cost: for models without a per-image
// checkpoint the retry re-calls the billed provider endpoint for the whole
// batch, so three attempts against a permanently broken URL pay the provider
// three times and produce nothing. Re-requesting the same URL cannot fix a
// blocked address, an oversized body or a redirect loop.
export function isPermanentProviderError(msg: string): boolean {
  return (
    /\b40[13]\b/.test(msg) ||
    // The other CLIENT-ERROR statuses (pass 71). `\b40[13]\b` covers auth and
    // permission; a 400 "invalid size" / 422 "invalid parameter" / 404 "path not
    // found" is equally unfixable by re-sending the identical request, yet every
    // one of them was transient — requeued with 60s then 120s of backoff, the
    // same create re-issued (three of them on the video lane), and the
    // customer's refund held for ~3 minutes for a failure known in
    // milliseconds. Probed on the pass-70 tree: `400: <html>bad request</html>`,
    // `404: model path not found` and `422: invalid parameter` all answered
    // isPermanent=false.
    //
    // 408 (request timeout), 409 (conflict), 425 (too early) and 429 (rate
    // limit) are deliberately absent: they are retryable by definition, and 429
    // is exactly what a busy provider answers with. The match is anchored to the
    // `"<status>: <body>"` shape callWithKeys builds, so a status number quoted
    // inside a provider's prose ("retry in 400 ms") cannot trip it — the
    // narrower direction, because mistaking a transient failure for a permanent
    // one costs a paid generation while the reverse costs two unused calls.
    /(?:^|[^\d])(?:400|404|405|406|410|413|415|422): /.test(msg) ||
    /access ?denied/i.test(msg) ||
    /invalid.?api.?key/i.test(msg) ||
    /model .*is offline/i.test(msg) ||
    /model not exist/i.test(msg) ||
    // A provider's own content refusal, in every spelling a provider actually
    // uses (pass 71). The pattern knew the PROSE form ("content policy
    // violation") and nothing else, so the CODE spellings — the ordinary way a
    // gateway reports this — were classified transient and the attempt was
    // retried. Probed against the real strings: `content_policy_violation`
    // (OpenAI/ModelVerse), Ark's `Input/OutputTextSensitiveContentDetected` and
    // DashScope's `DataInspectionFailed` ("inappropriate content") all answered
    // isPermanent=false. Three consequences, all of them the class this list
    // exists for: the same refused prompt is re-sent to the provider up to
    // maxAttempts times (a provider that scores abuse hits counts three, not
    // one), the customer's refund waits out the exponential backoff (60s + 120s)
    // instead of arriving in seconds, and on the video lane the attempt budget
    // is spent on requests the provider will never accept.
    //
    // Underscore/hyphen and camel case are matched explicitly rather than with
    // a `\W` class: `DataInspectionFailed` has no separator at all.
    /safety system|content[ _-]?(?:policy|moderation)|sensitive[ _-]?content|data[ _-]?inspection[ _-]?failed|inappropriate content|flagged.*moderation/i.test(
      msg,
    ) ||
    /unknown-model|model-not-supported|not-a-video-model|model-disabled/i.test(msg) ||
    // The job's reference image is gone from storage: /api/edit and the i2v
    // path both charge for an input the job can no longer read, and a retry
    // re-reads the same missing object. Terminal so the caller is refunded
    // immediately instead of after three backoffs.
    /ref-image-missing/i.test(msg) ||
    // Delivery refused because the funding order was refunded mid-flight (see
    // completeJob): retrying re-bills the provider for output that will be
    // refused again.
    /job-cancelled-refunded-order/i.test(msg) ||
    // The create call was already billed, but the id it answered cannot be
    // polled (non-string, empty, NUL/control characters, a malformed shape).
    // A retry creates and pays for ANOTHER upstream task — up to maxAttempts
    // of them, none collectable (pass 39).
    /unusable task id/i.test(msg) ||
    // An oversized provider payload is a property of the RESPONSE, not of our
    // request, so the retry re-calls the billed endpoint and pays again for the
    // images that were not checkpointed — the same three-times-billed shape as
    // the download class below, which it is the twin of (both are size refusals
    // in lib/store.ts). `download-too-large` was on this list; its encode-side
    // sibling was not, so a gateway answering with a >40MB b64_json quietly
    // bought the same generation three times and still delivered nothing.
    /image-too-large/i.test(msg) ||
    // A 2xx whose BODY cannot be used (pass 66). The create call succeeded and
    // the provider billed it; retrying re-POSTs /images/generations (or creates
    // a second video task whose id is then lost) and pays again for the same
    // unusable answer. The status was already checked before the body was read,
    // so these messages can only come from a 2xx with a broken payload: HTML or
    // truncated JSON, `{"data":[]}`, or fewer images than requested. All are
    // properties of the RESPONSE, exactly like the size refusals above.
    /returned no b64_json|returned no images|returned \d+ of \d+ images/i.test(msg) ||
    // Two 2xx-response refusals added in pass 70 that sat just outside the list.
    // `empty-image` is lib/store's decode guard: a body whose base64 decodes to
    // zero bytes is a broken payload, and retrying re-calls the BILLED endpoint
    // for the same nothing. `not-a-video` is saveRemoteVideo's container check:
    // a 200 HTML/JSON error page from a CDN or relay cannot become a playable
    // clip on a retry either. Both are properties of the response.
    /empty-image|not-a-video/i.test(msg) ||
    // A 2xx whose body is a JSON PRIMITIVE (pass 71). `null` was the one shape
    // that escaped both this list and the siblings above: reading `.data` off it
    // threw a raw TypeError ("Cannot read properties of null …"), which matched
    // no branch and was retried — re-POSTing a create the provider had already
    // billed. lib/providers' readJsonCapped now refuses the shape with this
    // wording, so the classification no longer depends on how the caller reads
    // the value.
    /no usable JSON body/i.test(msg) ||
    /unexpected token|unexpected end of json|is not valid json|json\.parse/i.test(msg) ||
    /fetch failed|blocked-internal|blocked-port|invalid-url|download-too-large|too-many-redirects|download failed/i.test(
      msg,
    )
  );
}
