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
    /fetch failed|blocked-internal|blocked-port|invalid-url|download-too-large|too-many-redirects|download failed/i.test(
      msg,
    )
  );
}
