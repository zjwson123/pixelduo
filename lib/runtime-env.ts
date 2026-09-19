// One definition of "this process is a production deployment", shared by the
// boot assertions and by every guard that refuses a test-only escape hatch.
//
// The predicate is deliberately phrased as "not development and not test"
// rather than "== production". A deployment that spells NODE_ENV any other way
// — "staging", "prod", "Production", or leaves it unset in a custom entrypoint
// — is a deployment, and used to be treated as a dev machine by these guards:
// the mock payment provider self-fulfilled orders, test-mode Stripe/Paddle keys
// minted real credits from genuinely signed webhooks, and MOCK_IMAGE_PROVIDER
// served stub images for real credits. instrumentation.ts and lib/twofa.ts were
// fixed to this shape first; the payment and provider gates kept the old
// exact-string test, so one process could be "production enough" to demand an
// https NEXTAUTH_URL and a real NEXTAUTH_SECRET while still being "not
// production" for the money path.
//
// Skipping a guard is now something a runtime must ASK for by declaring itself
// development or test.
export function isProductionRuntime(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV !== "development" && env.NODE_ENV !== "test";
}
