import { z } from "zod";
import type { ChargeQuote, CreatedPayment, CreateRequest, GatewayState, PaymentGateway, WebhookResult } from "./types";

/**
 * PayPal Orders v2 (create order -> buyer approves -> server captures) + webhook verification via PayPal's
 * verify-webhook-signature API. NOT yet exercised against the real sandbox.
 *
 * INR: PayPal's developer docs say Indian PayPal accounts cannot receive INR, so PayPal charges in a foreign
 * currency (default USD) converted at a rate YOU set (PAYPAL_INR_PER_UNIT). The traveller sees the converted amount
 * and the rate before paying; PayPal may add its own conversion/fees.
 */
export interface PayPalConfig {
  env: "sandbox" | "live";
  clientId: string;
  clientSecret: string;
  webhookId: string;
  currency: string; // e.g. USD
  inrPerUnit: number; // e.g. 85 means 1 USD = 85 INR
}

const BASE = { sandbox: "https://api-m.sandbox.paypal.com", live: "https://api-m.paypal.com" } as const;

const TokenBody = z.object({ access_token: z.string(), expires_in: z.number().optional() });
const OrderBody = z.object({
  id: z.string(),
  status: z.string(),
  links: z.array(z.object({ rel: z.string(), href: z.string() })).optional(),
  purchase_units: z.array(z.object({
    payments: z.object({ captures: z.array(z.object({ id: z.string(), status: z.string(), amount: z.object({ value: z.string(), currency_code: z.string() }) })).optional() }).optional(),
    amount: z.object({ value: z.string(), currency_code: z.string() }).optional(),
  })).optional(),
});
const EventBody = z.object({
  id: z.string(),
  event_type: z.string(),
  resource: z.object({ custom_id: z.string().optional(), purchase_units: z.array(z.object({ custom_id: z.string().optional() })).optional() }).passthrough(),
});

const toMinor = (value: string) => Math.round(parseFloat(value) * 100);

export class PayPalGateway implements PaymentGateway {
  readonly id = "paypal" as const;
  private cached: { token: string; exp: number } | null = null;

  constructor(private cfg: PayPalConfig, private f: typeof fetch = fetch) {}

  static fromEnv(env: NodeJS.ProcessEnv = process.env, f?: typeof fetch): PayPalGateway | null {
    const { PAYPAL_CLIENT_ID: id, PAYPAL_CLIENT_SECRET: secret, PAYPAL_WEBHOOK_ID: wid } = env;
    const rate = Number(env.PAYPAL_INR_PER_UNIT);
    if (!id || !secret || !wid || !Number.isFinite(rate) || rate <= 0) return null;
    return new PayPalGateway({ env: env.PAYPAL_ENV === "live" ? "live" : "sandbox", clientId: id, clientSecret: secret, webhookId: wid, currency: (env.PAYPAL_CURRENCY ?? "USD").toUpperCase(), inrPerUnit: rate }, f);
  }

  chargeFor(amountPaise: number): ChargeQuote {
    const minor = Math.round((amountPaise / 100 / this.cfg.inrPerUnit) * 100);
    if (minor < 100) throw new Error("Amount is too small to charge through PayPal.");
    const shown = (minor / 100).toFixed(2);
    return { minor, currency: this.cfg.currency, disclosure: `You will be charged ${this.cfg.currency} ${shown} (converted at ₹${this.cfg.inrPerUnit} per ${this.cfg.currency}). PayPal may apply its own fees or exchange rate.` };
  }

  private async token(): Promise<string> {
    if (this.cached && this.cached.exp - 60_000 > Date.now()) return this.cached.token;
    const res = await this.f(`${BASE[this.cfg.env]}/v1/oauth2/token`, {
      method: "POST",
      headers: { authorization: `Basic ${Buffer.from(`${this.cfg.clientId}:${this.cfg.clientSecret}`).toString("base64")}`, "content-type": "application/x-www-form-urlencoded" },
      body: "grant_type=client_credentials",
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`PayPal token request failed (${res.status})`);
    const t = TokenBody.parse(await res.json());
    this.cached = { token: t.access_token, exp: Date.now() + (t.expires_in ?? 300) * 1000 };
    return t.access_token;
  }

  private async call(path: string, init: RequestInit & { idem?: string } = {}): Promise<Response> {
    const { idem, ...rest } = init;
    return this.f(`${BASE[this.cfg.env]}${path}`, {
      ...rest,
      headers: { "content-type": "application/json", authorization: `Bearer ${await this.token()}`, ...(idem ? { "paypal-request-id": idem } : {}) },
      signal: AbortSignal.timeout(10_000),
    });
  }

  async create(req: CreateRequest): Promise<CreatedPayment> {
    const res = await this.call("/v2/checkout/orders", {
      method: "POST",
      idem: req.paymentId, // PayPal-Request-Id makes retries safe
      body: JSON.stringify({
        intent: "CAPTURE",
        purchase_units: [{
          reference_id: req.paymentId,
          custom_id: req.paymentId,
          description: req.description.slice(0, 120),
          amount: { currency_code: req.charge.currency, value: (req.charge.minor / 100).toFixed(2) },
        }],
        payment_source: { paypal: { experience_context: { return_url: req.returnUrl, cancel_url: req.cancelUrl, user_action: "PAY_NOW", shipping_preference: "NO_SHIPPING" } } },
      }),
    });
    if (!res.ok) throw new Error(`PayPal create failed (${res.status})`);
    const o = OrderBody.parse(await res.json());
    const link = o.links?.find((l) => l.rel === "payer-action" || l.rel === "approve")?.href;
    if (!link || !link.startsWith("https://")) throw new Error("PayPal did not return an approval link.");
    return { gatewayOrderId: o.id, redirectUrl: link };
  }

  async reconcile(args: { paymentId: string; gatewayOrderId: string }): Promise<GatewayState> {
    const id = encodeURIComponent(args.gatewayOrderId);
    let res = await this.call(`/v2/checkout/orders/${id}`);
    if (!res.ok) throw new Error(`PayPal order lookup failed (${res.status})`);
    let o = OrderBody.parse(await res.json());
    if (o.status === "APPROVED") {
      // The buyer approved: capture now (idempotent via PayPal-Request-Id).
      res = await this.call(`/v2/checkout/orders/${id}/capture`, { method: "POST", idem: `cap-${args.paymentId}`, body: "{}" });
      if (!res.ok) throw new Error(`PayPal capture failed (${res.status})`);
      o = OrderBody.parse(await res.json());
    }
    const cap = o.purchase_units?.[0]?.payments?.captures?.[0];
    if (o.status === "COMPLETED" && cap?.status === "COMPLETED") {
      return { status: "COMPLETED", amountMinor: toMinor(cap.amount.value), currency: cap.amount.currency_code, txnId: cap.id };
    }
    if (o.status === "VOIDED" || cap?.status === "DECLINED" || cap?.status === "FAILED") return { status: "FAILED" };
    return { status: "PENDING" };
  }

  async verifyWebhook(headers: Headers, rawBody: string): Promise<WebhookResult> {
    let event: unknown;
    try {
      event = JSON.parse(rawBody);
    } catch {
      return { ok: false };
    }
    const parsed = EventBody.safeParse(event);
    const h = (n: string) => headers.get(n) ?? "";
    if (!parsed.success || !h("paypal-transmission-id") || !h("paypal-transmission-sig")) return { ok: false };
    // cert_url is passed to PayPal's verifier, never fetched by us.
    const res = await this.call("/v1/notifications/verify-webhook-signature", {
      method: "POST",
      body: JSON.stringify({
        auth_algo: h("paypal-auth-algo"),
        cert_url: h("paypal-cert-url"),
        transmission_id: h("paypal-transmission-id"),
        transmission_sig: h("paypal-transmission-sig"),
        transmission_time: h("paypal-transmission-time"),
        webhook_id: this.cfg.webhookId,
        webhook_event: event,
      }),
    });
    if (!res.ok) return { ok: false };
    const v = z.object({ verification_status: z.string() }).safeParse(await res.json());
    if (!v.success || v.data.verification_status !== "SUCCESS") return { ok: false };
    const r = parsed.data.resource;
    return { ok: true, eventId: parsed.data.id, paymentId: r.custom_id ?? r.purchase_units?.[0]?.custom_id ?? null };
  }
}
