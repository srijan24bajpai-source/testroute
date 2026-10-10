export type GatewayId = "paypal" | "phonepe";

export interface ChargeQuote {
  /** Amount the gateway will actually charge, in minor units of `currency` (paise, cents). */
  minor: number;
  currency: string;
  /** Human-readable disclosure shown before the traveller pays (e.g. the exchange rate used). */
  disclosure: string | null;
}

export interface CreateRequest {
  paymentId: string; // our id; also the gateway-side merchant reference
  charge: ChargeQuote;
  description: string;
  returnUrl: string;
  cancelUrl: string;
}

export interface CreatedPayment {
  gatewayOrderId: string;
  redirectUrl: string;
}

export interface GatewayState {
  status: "PENDING" | "COMPLETED" | "FAILED";
  /** What the gateway says was actually paid. Always compared with what we expected. */
  amountMinor?: number;
  currency?: string;
  txnId?: string;
}

export type WebhookResult =
  | { ok: false }
  | { ok: true; eventId: string; paymentId: string | null };

export interface PaymentGateway {
  readonly id: GatewayId;
  /** Convert our INR amount into what this gateway charges. Throws if the gateway can't be used for this amount. */
  chargeFor(amountPaise: number): ChargeQuote;
  create(req: CreateRequest): Promise<CreatedPayment>;
  /** Ask the gateway (server-to-server) for the authoritative state. PayPal also captures an approved order here. */
  reconcile(args: { paymentId: string; gatewayOrderId: string }): Promise<GatewayState>;
  /** Authenticate a webhook. The body is never trusted for status: callers re-check via reconcile(). */
  verifyWebhook(headers: Headers, rawBody: string): Promise<WebhookResult>;
}
