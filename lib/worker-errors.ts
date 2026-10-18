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
    /access ?denied/i.test(msg) ||
    /invalid.?api.?key/i.test(msg) ||
    /model .*is offline/i.test(msg) ||
    /model not exist/i.test(msg) ||
    /safety system|content (policy|moderation)|flagged.*moderation/i.test(msg) ||
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
    /fetch failed|blocked-internal|blocked-port|invalid-url|download-too-large|too-many-redirects|download failed/i.test(
      msg,
    )
  );
}
