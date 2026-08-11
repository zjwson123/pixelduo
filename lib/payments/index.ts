import type { PaymentProvider } from "./types";
import { MockProvider } from "./mock";
import { StripeProvider } from "./stripe";
import { PaddleProvider } from "./paddle";

let cached: PaymentProvider | null | undefined;

export function getPaymentProvider(): PaymentProvider {
  if (cached) return cached;
  const name = process.env.PAYMENT_PROVIDER ?? "mock";
  cached =
    name === "stripe" ? new StripeProvider() : name === "paddle" ? new PaddleProvider() : new MockProvider();
  return cached;
}

export function _resetPaymentProviderForTests() {
  cached = undefined;
}
