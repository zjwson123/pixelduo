import type { PaymentProvider } from "./types";
import { MockProvider } from "./mock";
import { StripeProvider } from "./stripe";
import { PaddleProvider } from "./paddle";
import { isProductionRuntime } from "../runtime-env";

let cached: PaymentProvider | null | undefined;

// Production must never silently fall back to the unsigned mock provider.
// If PAYMENT_PROVIDER is unset or "mock" in a production runtime, throw
// instead of allowing unauthenticated webhook fulfillment. CI (ci-local.sh)
// sets PAYMENT_ALLOW_MOCK=1 to test the checkout flow against a production
// build without a real provider.
//
// "Production" is the shared runtime predicate (lib/runtime-env.ts), not an
// exact `NODE_ENV === "production"` string test: a deployment that spelled it
// "staging" — or left it unset in a custom entrypoint — failed that test, took
// .env.example's shipped PAYMENT_PROVIDER default, and fulfilled orders inline
// with no payment at all.
function resolvePaymentProviderName(): string {
  const name = process.env.PAYMENT_PROVIDER ?? "";
  if (!name || name === "mock") {
    if (isProductionRuntime() && process.env.PAYMENT_ALLOW_MOCK !== "1") {
      throw new Error(
        "PAYMENT_PROVIDER=mock is not allowed in production — set to 'stripe' or 'paddle'",
      );
    }
    return "mock";
  }
  // Fail closed on any unrecognized value: defaulting a typo ("Stripe",
  // "stripe ", "alipay") to the unsigned MockProvider would silently enable
  // free checkout fulfillment and unsigned webhooks — the exact failure the
  // production gate above exists to prevent.
  if (name !== "stripe" && name !== "paddle") {
    throw new Error(`unknown PAYMENT_PROVIDER '${name}' — use 'stripe', 'paddle' or 'mock'`);
  }
  return name;
}

// "mock" | "live" — for copy that must not promise something the server will
// not honour.
//
// components/workbench.tsx told every buyer "Beta shell · no real charge" in the
// checkout modal and on the pricing tab, unconditionally, while a production
// deployment cannot even boot with the mock provider (assertProductionConfig →
// resolvePaymentProviderName throws, and docker-compose.prod.yml makes a real
// provider mandatory). So the one string that describes whether money moves was
// a constant, and on a real deployment it was a lie told at the point of
// payment. Derived here instead, and fail-closed: anything that is not
// provably mock reads as live, because "no real charge" is a promise and only
// the mock provider can keep it.
export function paymentMode(): "mock" | "live" {
  try {
    return resolvePaymentProviderName() === "mock" ? "mock" : "live";
  } catch {
    return "live";
  }
}

export function getPaymentProvider(): PaymentProvider {
  if (cached) return cached;
  const name = resolvePaymentProviderName();
  cached =
    name === "stripe" ? new StripeProvider() : name === "paddle" ? new PaddleProvider() : new MockProvider();
  return cached;
}

// The one provider-supplied value that becomes a browser NAVIGATION.
//
// /api/checkout hands the hosted-checkout link to the buyer's browser, and
// components/workbench.tsx assigns it to `window.location`. A `javascript:` (or
// `data:`) URL there runs in THIS origin — CSP's script-src 'unsafe-inline'
// permits it — with the buyer's session: a compromised or misconfigured
// provider response would escalate from "can redirect a payment" to "can act as
// the signed-in user". Every other provider-controlled value in this codebase is
// treated as untrusted (SSRF-pinned downloads, bounded error text), and the
// checkout link is the same rule at the last hop. Only an absolute http(s) URL
// is a destination a browser may be sent to; parsing the protocol (rather than a
// string prefix) is what rejects the `JaVaScRiPt:` spellings and whitespace
// padding a prefix test misses.
export function checkoutDestinationUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

// Every provider whose webhook signature can still be verified by this
// deployment, selected provider first. A provider switch is a config change who
// only takes effect on the CURRENT provider: orders created before it keep
// receiving refunds and disputes at the previous provider, signed with the
// previous secret, and the route must accept and act on those deliveries. The
// alternate is considered only when its signature header is present AND its
// secret is configured. It is constructed VERIFIER-ONLY: webhook verification
// needs the signing secret, not the checkout API key, so removing the old
// provider's key (the natural cleanup after a switch) must not silently drop
// its refunds — which is what requiring a full provider instance did: the
// delivery answered 400, the provider stopped retrying, and credits were kept.
// The route's order-provider match is what prevents a valid event from one
// provider acting on an order created by another.
const SIGNATURE_HEADERS: Array<{ name: "stripe" | "paddle"; header: string; secretVar: string }> = [
  { name: "stripe", header: "stripe-signature", secretVar: "STRIPE_WEBHOOK_SECRET" },
  { name: "paddle", header: "paddle-signature", secretVar: "PADDLE_WEBHOOK_SECRET" },
];

export function getWebhookVerifiers(headers: Headers): PaymentProvider[] {
  const verifiers: PaymentProvider[] = [getPaymentProvider()];
  for (const { name, header, secretVar } of SIGNATURE_HEADERS) {
    if (!headers.get(header)) continue;
    if (verifiers.some((p) => p.name === name)) continue;
    if (!process.env[secretVar]) continue;
    try {
      verifiers.push(
        name === "stripe" ? new StripeProvider({ webhookOnly: true }) : new PaddleProvider({ webhookOnly: true }),
      );
    } catch {
      // Its signing secret is unusable (or the SDK refused the dummy
      // credential), so it cannot verify anything.
    }
  }
  return verifiers;
}

export function _resetPaymentProviderForTests() {
  cached = undefined;
}
