import { createHmac, timingSafeEqual } from "crypto";
import { Paddle, Environment } from "@paddle/paddle-node-sdk";
import type { PaymentWebhookEvent } from "./types";
import type { CheckoutSession, CreateCheckoutInput, PaymentProvider } from "./types";

// Paddle Billing (Merchant of Record for overseas sales). Sandbox works with a
// sandbox API key only — no business entity required. Set PAYMENT_PROVIDER=paddle
// + PADDLE_API_KEY + PADDLE_WEBHOOK_SECRET (sandbox webhook secret from the
// Paddle dashboard; signature header is Paddle-Signature).
//
// Event mapping:
// - transaction.completed → paid (fulfil order)
// - adjustment.created (action refund|chargeback, status approved) → refunded
// Order link: customData.orderId at checkout; refunds resolve via
// transactionId → Order.providerOrderId.
export class PaddleProvider implements PaymentProvider {
  name = "paddle";
  private client: Paddle;
  private webhookSecret: string;

  constructor(opts?: { client?: Paddle; webhookSecret?: string }) {
    const key = process.env.PADDLE_API_KEY;
    if (!opts?.client && !key) {
      throw new Error("PADDLE_API_KEY is required when PAYMENT_PROVIDER=paddle");
    }
    // Sandbox transactions complete with Paddle's public test instruments and
    // sandbox-signed webhooks verify against the sandbox secret — in
    // production that would fulfill real credits for fake payments.
    if (
      process.env.NODE_ENV === "production" &&
      !opts?.client &&
      process.env.PADDLE_ENVIRONMENT !== "production"
    ) {
      throw new Error("PADDLE_ENVIRONMENT must be 'production' when NODE_ENV=production");
    }
    this.webhookSecret = opts?.webhookSecret ?? process.env.PADDLE_WEBHOOK_SECRET ?? "";
    this.client =
      opts?.client ??
      new Paddle(key as string, {
        environment: process.env.PADDLE_ENVIRONMENT === "production" ? Environment.production : Environment.sandbox,
      });
  }

  async createCheckout(input: CreateCheckoutInput): Promise<CheckoutSession> {
    const tx = await this.client.transactions.create({
      items: [
        {
          quantity: 1,
          price: {
            description: input.itemName,
            // Paddle amounts are in the lowest currency denomination (cents).
            unitPrice: { amount: String(Math.round(input.amountUsd * 100)), currencyCode: "USD" },
            product: { name: "PixelDuo credits", taxCategory: "digital-goods" },
          },
        },
      ],
      customData: { orderId: input.orderId },
      collectionMode: "automatic",
    });
    const url = tx.checkout?.url;
    if (!url) throw new Error("paddle: create transaction returned no checkout url");
    return { checkoutUrl: url, providerSessionId: tx.id };
  }

  // In-repo HMAC verification instead of client.webhooks.unmarshal: the SDK
  // hard-codes a 5-second timestamp tolerance, so any delayed delivery or
  // retry past 5s is rejected (400) and a genuinely paid order can strand.
  // Same algorithm (HMAC-SHA256 over `${ts}:${rawBody}`, v1 and legacy h1
  // tags), with a 5-minute tolerance mirroring Stripe's constructEvent.
  async verifyWebhook(rawBody: string, headers: Headers): Promise<PaymentWebhookEvent | null> {
    const signature = headers.get("paddle-signature");
    if (!this.webhookSecret || !signature) return null;
    const parts = signature.split(";").reduce<Record<string, string>>((acc, kv) => {
      const idx = kv.indexOf("=");
      if (idx > 0) acc[kv.slice(0, idx).trim()] = kv.slice(idx + 1).trim();
      return acc;
    }, {});
    const ts = Number(parts.ts);
    const mac = parts.v1 ?? parts.h1;
    if (!Number.isFinite(ts) || !mac) return null;
    if (Math.abs(Date.now() / 1000 - ts) > 300) return null;
    // Compare hex-to-hex: the signature carries the hex digest, so digest()
    // must be hex-encoded too or the byte lengths never match.
    const expectedHex = createHmac("sha256", this.webhookSecret).update(`${ts}:${rawBody}`).digest("hex");
    const a = Buffer.from(expectedHex, "utf8");
    const b = Buffer.from(mac, "utf8");
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

    let parsed: { event_id?: string; event_type?: string; data?: Record<string, unknown> };
    try {
      parsed = JSON.parse(rawBody) as typeof parsed;
    } catch {
      return null;
    }
    if (!parsed.event_id || parsed.event_type === undefined) return null;
    const data = parsed.data ?? {};
    try {
      if (parsed.event_type === "transaction.completed") {
        if (data.status !== "completed") return null;
        const customData = data.custom_data as Record<string, unknown> | null ?? data.customData as Record<string, unknown> | null;
        return {
          provider: this.name,
          eventId: parsed.event_id,
          type: "paid",
          orderId: typeof customData?.orderId === "string" ? customData.orderId : undefined,
          providerOrderId: typeof data.id === "string" ? data.id : undefined,
          raw: parsed,
        };
      }
      if (parsed.event_type === "adjustment.created") {
        if (data.status !== "approved") return null;
        if (data.action !== "refund" && data.action !== "chargeback") return null;
        // Paddle adjustments are whole-item refunds; treat approved ones as full.
        return {
          provider: this.name,
          eventId: parsed.event_id,
          type: "refunded",
          fullRefund: true,
          providerOrderId:
            typeof data.transaction_id === "string" ? data.transaction_id
            : typeof data.transactionId === "string" ? data.transactionId
            : undefined,
          raw: parsed,
        };
      }
      return null;
    } catch {
      return null;
    }
  }
}
