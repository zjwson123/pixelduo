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

export function _resetPaymentProviderForTests() {
  cached = undefined;
}
