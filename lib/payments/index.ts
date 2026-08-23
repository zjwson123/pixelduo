import type { PaymentProvider } from "./types";
import { MockProvider } from "./mock";
import { StripeProvider } from "./stripe";
import { PaddleProvider } from "./paddle";

let cached: PaymentProvider | null | undefined;

// Production must never silently fall back to the unsigned mock provider.
// If PAYMENT_PROVIDER is unset or "mock" while NODE_ENV=production, throw
// instead of allowing unauthenticated webhook fulfillment.
function resolvePaymentProviderName(): string {
  const name = process.env.PAYMENT_PROVIDER ?? "";
  if (!name || name === "mock") {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "PAYMENT_PROVIDER=mock is not allowed in production — set to 'stripe' or 'paddle'",
      );
    }
    return "mock";
  }
  return name;
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
