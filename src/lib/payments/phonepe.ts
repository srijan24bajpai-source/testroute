import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { ChargeQuote, CreatedPayment, CreateRequest, GatewayState, PaymentGateway, WebhookResult } from "./types";

/**
 * PhonePe Standard Checkout v2 (UPI, cards, wallets). Written against PhonePe's developer documentation
 * (OAuth token -> /checkout/v2/pay -> redirect -> webhook + Order Status). NOT yet exercised against the real
 * sandbox: test in PhonePe's sandbox before enabling. Amounts are INR paise (minimum 100).
 */
export interface PhonePeConfig {
  env: "sandbox" | "production";
  clientId: string;
  clientSecret: string;
  clientVersion: string;
  webhookUsername: string;
  webhookPassword: string;
}

const HOSTS = {
  sandbox: { token: "https://api-preprod.phonepe.com/apis/pg-sandbox/v1/oauth/token", api: "https://api-preprod.phonepe.com/apis/pg-sandbox" },
  production: { token: "https://api.phonepe.com/apis/identity-manager/v1/oauth/token", api: "https://api.phonepe.com/apis/pg" },
} as const;

const WebhookBody = z.object({
  event: z.string(),
  payload: z.object({ merchantOrderId: z.string().max(63), state: z.string().optional(), orderId: z.string().optional() }),
});

const TokenBody = z.object({ access_token: z.string(), expires_at: z.number().optional(), token_type: z.string().optional() });
const CreateBody = z.object({ orderId: z.string(), redirectUrl: z.string().url() });
const StatusBody = z.object({
  state: z.string(),
  amount: z.union([z.number(), z.string()]).optional(),
  paymentDetails: z.array(z.object({ transactionId: z.string().optional() }).passthrough()).optional(),
});

export class PhonePeGateway implements PaymentGateway {
  readonly id = "phonepe" as const;
  private cached: { token: string; exp: number } | null = null;

  constructor(private cfg: PhonePeConfig, private f: typeof fetch = fetch) {}

  static fromEnv(env: NodeJS.ProcessEnv = process.env, f?: typeof fetch): PhonePeGateway | null {
    const { PHONEPE_CLIENT_ID: id, PHONEPE_CLIENT_SECRET: secret, PHONEPE_WEBHOOK_USERNAME: wu, PHONEPE_WEBHOOK_PASSWORD: wp } = env;
    if (!id || !secret || !wu || !wp) return null;
    return new PhonePeGateway(
      { env: env.PHONEPE_ENV === "production" ? "production" : "sandbox", clientId: id, clientSecret: secret, clientVersion: env.PHONEPE_CLIENT_VERSION ?? "1", webhookUsername: wu, webhookPassword: wp },
      f,
    );
  }

  chargeFor(amountPaise: number): ChargeQuote {
    if (!Number.isInteger(amountPaise) || amountPaise < 100) throw new Error("Amount below PhonePe's ₹1 minimum.");
    return { minor: amountPaise, currency: "INR", disclosure: null };
  }

  private async token(): Promise<string> {
    if (this.cached && this.cached.exp - 60_000 > Date.now()) return this.cached.token;
    const res = await this.f(HOSTS[this.cfg.env].token, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: this.cfg.clientId, client_version: this.cfg.clientVersion, client_secret: this.cfg.clientSecret, grant_type: "client_credentials" }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`PhonePe token request failed (${res.status})`);
    const t = TokenBody.parse(await res.json());
    const exp = t.expires_at ? (t.expires_at < 1e12 ? t.expires_at * 1000 : t.expires_at) : Date.now() + 5 * 60_000;
    this.cached = { token: t.access_token, exp };
    return t.access_token;
  }

  async create(req: CreateRequest): Promise<CreatedPayment> {
    const res = await this.f(`${HOSTS[this.cfg.env].api}/checkout/v2/pay`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `O-Bearer ${await this.token()}` },
      body: JSON.stringify({
        merchantOrderId: req.paymentId, // our id; hyphens are allowed
        amount: req.charge.minor,
        expireAfter: 900,
        paymentFlow: { type: "PG_CHECKOUT", merchantUrls: { redirectUrl: req.returnUrl } },
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`PhonePe create failed (${res.status})`);
    const b = CreateBody.parse(await res.json());
    return { gatewayOrderId: b.orderId, redirectUrl: b.redirectUrl };
  }

  async reconcile(args: { paymentId: string; gatewayOrderId: string }): Promise<GatewayState> {
    const res = await this.f(`${HOSTS[this.cfg.env].api}/checkout/v2/order/${encodeURIComponent(args.paymentId)}/status?details=false`, {
      headers: { "content-type": "application/json", authorization: `O-Bearer ${await this.token()}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`PhonePe status failed (${res.status})`);
    const b = StatusBody.parse(await res.json());
    const amount = b.amount === undefined ? undefined : Number(b.amount);
    const status = b.state === "COMPLETED" ? "COMPLETED" : b.state === "FAILED" ? "FAILED" : "PENDING";
    return { status, amountMinor: Number.isFinite(amount) ? amount : undefined, currency: "INR", txnId: b.paymentDetails?.[0]?.transactionId };
  }

  /** PhonePe sends `Authorization: SHA256(username:password)`. Compare in constant time. */
  async verifyWebhook(headers: Headers, rawBody: string): Promise<WebhookResult> {
    const expected = createHash("sha256").update(`${this.cfg.webhookUsername}:${this.cfg.webhookPassword}`).digest("hex");
    const given = (headers.get("authorization") ?? "").trim().toLowerCase();
    const a = Buffer.from(given);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false };
    let parsed;
    try {
      parsed = WebhookBody.safeParse(JSON.parse(rawBody));
    } catch {
      return { ok: false };
    }
    if (!parsed.success) return { ok: false };
    const { event, payload } = parsed.data;
    return { ok: true, eventId: `${payload.merchantOrderId}:${event}:${payload.state ?? ""}`, paymentId: payload.merchantOrderId };
  }
}
