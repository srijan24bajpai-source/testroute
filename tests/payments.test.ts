import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryStore, _setStoreForTests } from "@/lib/booking/store";
import { createQuote, type ConfirmInput } from "@/lib/booking/service";
import { handlePaymentWebhook, paymentStatus, settlePayment, startCheckout, type PayDeps } from "@/lib/payments/service";
import { PhonePeGateway } from "@/lib/payments/phonepe";
import { PayPalGateway } from "@/lib/payments/paypal";
import { getGateway, configuredGateways } from "@/lib/payments/registry";
import type { CreateRequest, CreatedPayment, GatewayState, PaymentGateway, WebhookResult } from "@/lib/payments/types";
import { NOW, SandboxBookingProvider, directItinerary, fareMap, pax } from "./helpers";
import type { Itinerary } from "@/lib/domain/types";
import { _resetRateLimits } from "@/lib/security/rate-limit";

class FakeGateway implements PaymentGateway {
  readonly id = "phonepe" as const;
  state: GatewayState = { status: "PENDING" };
  creates = 0;
  failCreate = false;
  webhookOk = true;
  webhookPaymentId: string | null = null;
  lastReq: CreateRequest | null = null;
  chargeFor(p: number) { return { minor: p, currency: "INR", disclosure: null }; }
  async create(req: CreateRequest): Promise<CreatedPayment> {
    this.creates++;
    if (this.failCreate) throw new Error("gateway down");
    this.lastReq = req;
    return { gatewayOrderId: `GW-${req.paymentId}`, redirectUrl: `https://pay.example.test/${req.paymentId}` };
  }
  async reconcile() { return this.state; }
  async verifyWebhook(): Promise<WebhookResult> { return this.webhookOk ? { ok: true, eventId: "e1", paymentId: this.webhookPaymentId } : { ok: false }; }
}

let store: MemoryStore;
let provider: SandboxBookingProvider;
let gw: FakeGateway;
let deps: PayDeps;
let itin: Itinerary;
let n = 0;

beforeEach(async () => {
  store = new MemoryStore();
  itin = await directItinerary();
  provider = new SandboxBookingProvider(fareMap(itin));
  gw = new FakeGateway();
  n = 0;
  deps = {
    store, now: () => NOW, origin: "https://app.example.test",
    id: () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
    getBookingProvider: (id) => (id === "sandbox" ? provider : undefined),
    gateway: () => gw,
  };
});

const input = (q: { id: string; hash: string; totalGroup: number }, over: Partial<ConfirmInput> = {}): ConfirmInput => ({
  quoteId: q.id, quoteHash: q.hash, acknowledgedTotal: q.totalGroup, acceptedConditions: true, idempotencyKey: "idem-key-0000000001", passengers: pax, ...over,
});

async function checkout(over: Partial<ConfirmInput> = {}) {
  const q = await createQuote(deps, "alice", itin);
  const out = await startCheckout(deps, "alice", input(q, over), "phonepe");
  if (out.kind !== "redirect") throw new Error("expected redirect");
  return { q, out, paymentId: out.payment.id };
}

describe("checkout", () => {
  it("charges the server-side quote total, takes no booking action, and holds passenger details only temporarily", async () => {
    const { q, out } = await checkout();
    expect(out.payment.amountPaise).toBe(q.totalGroup);
    expect(gw.lastReq!.charge.minor).toBe(q.totalGroup);
    expect(out.redirectUrl).toContain("pay.example.test");
    expect(provider.bookCalls).toBe(0); // money first, purchase later
    expect([...store.bookings.values()][0].status).toBe("PAYMENT_PENDING");
    expect(store.held.size).toBe(1);
    expect(gw.lastReq!.returnUrl).toBe(`https://app.example.test/payment/return?pid=${out.payment.id}`);
  });

  it("refuses when the gateway is not configured: nothing created", async () => {
    const q = await createQuote(deps, "alice", itin);
    await expect(startCheckout({ ...deps, gateway: () => undefined }, "alice", input(q), "paypal")).rejects.toMatchObject({ code: "PAYMENTS_NOT_AVAILABLE" });
    expect(store.payments.size).toBe(0);
    expect(store.bookings.size).toBe(0);
  });

  it("never takes money for demo or search-only itineraries", async () => {
    const demo = await directItinerary("DEMO_ONLY");
    const q = await createQuote(deps, "alice", demo);
    await expect(startCheckout(deps, "alice", input(q), "phonepe")).rejects.toMatchObject({ code: "BOOKING_NOT_AVAILABLE" });
    expect(gw.creates).toBe(0);
    expect(store.payments.size).toBe(0);
  });

  it.each([
    ["wrong hash", { quoteHash: "b".repeat(64) }, "QUOTE_CHANGED"],
    ["wrong amount", { acknowledgedTotal: 5 }, "AMOUNT_MISMATCH"],
    ["no consent", { acceptedConditions: false }, "CONDITIONS_NOT_ACCEPTED"],
  ])("rejects %s before any payment is created", async (_n, over, code) => {
    const q = await createQuote(deps, "alice", itin);
    await expect(startCheckout(deps, "alice", input(q, over as Partial<ConfirmInput>), "phonepe")).rejects.toMatchObject({ code });
    expect(gw.creates).toBe(0);
  });

  it("double click creates one payment", async () => {
    const q = await createQuote(deps, "alice", itin);
    const [a, b] = await Promise.all([startCheckout(deps, "alice", input(q), "phonepe"), startCheckout(deps, "alice", input(q), "phonepe")]);
    expect(gw.creates).toBe(1);
    expect(store.payments.size).toBe(1);
    expect([a.kind, b.kind].sort()).toEqual(["existing", "redirect"]);
  });

  it("fare change re-quotes instead of charging", async () => {
    const q = await createQuote(deps, "alice", itin);
    provider.priceDelta = 70_000;
    const out = await startCheckout(deps, "alice", input(q), "phonepe");
    expect(out.kind).toBe("requote");
    expect(gw.creates).toBe(0);
    expect(store.payments.size).toBe(0);
  });

  it("gateway outage leaves nothing charged, nothing held, booking failed", async () => {
    gw.failCreate = true;
    const q = await createQuote(deps, "alice", itin);
    await expect(startCheckout(deps, "alice", input(q), "phonepe")).rejects.toMatchObject({ code: "PAYMENT_UNAVAILABLE" });
    expect([...store.payments.values()][0].status).toBe("FAILED");
    expect([...store.bookings.values()][0].status).toBe("FAILED");
    expect(store.held.size).toBe(0);
  });
});

describe("settlement", () => {
  it("pending gateway state changes nothing", async () => {
    const { paymentId } = await checkout();
    const p = await settlePayment(deps, paymentId);
    expect(p!.status).toBe("PENDING");
    expect(provider.bookCalls).toBe(0);
  });

  it("confirmed payment with the right amount triggers exactly one purchase and a provider reference", async () => {
    const { paymentId, q } = await checkout();
    gw.state = { status: "COMPLETED", amountMinor: q.totalGroup, currency: "INR", txnId: "TX1" };
    const p = await settlePayment(deps, paymentId);
    expect(p!.status).toBe("COMPLETED");
    const b = [...store.bookings.values()][0];
    expect(b.status).toBe("CONFIRMED");
    expect(b.externalRef).toMatch(/^SBX-/);
    expect(provider.bookCalls).toBe(1);
    expect(store.held.size).toBe(0); // passenger details deleted after use
  });

  it("webhook and poll racing still buy once", async () => {
    const { paymentId, q } = await checkout();
    gw.state = { status: "COMPLETED", amountMinor: q.totalGroup, currency: "INR" };
    await Promise.all([settlePayment(deps, paymentId), settlePayment(deps, paymentId), settlePayment(deps, paymentId)]);
    expect(provider.bookCalls).toBe(1);
  });

  it("wrong amount or currency is never fulfilled", async () => {
    for (const bad of [{ amountMinor: 1, currency: "INR" }, { amountMinor: 0, currency: "USD" }]) {
      store = new MemoryStore(); deps.store = store; provider.bookCalls = 0; n = 0;
      const { paymentId } = await checkout();
      gw.state = { status: "COMPLETED", ...bad };
      const p = await settlePayment(deps, paymentId);
      expect(p!.status).toBe("REVIEW_REQUIRED");
      expect([...store.bookings.values()][0].status).toBe("FAILED");
      expect(provider.bookCalls).toBe(0);
      expect(store.held.size).toBe(0);
    }
  });

  it("provider declines after payment: flagged REFUND_REQUIRED, not silently kept", async () => {
    provider.behaviour = "decline";
    const { paymentId, q } = await checkout();
    gw.state = { status: "COMPLETED", amountMinor: q.totalGroup, currency: "INR" };
    const p = await settlePayment(deps, paymentId);
    expect(p!.status).toBe("REFUND_REQUIRED");
    expect([...store.bookings.values()][0].status).toBe("FAILED");
  });

  it("provider timeout after payment: reconciliation required, still not 'confirmed'", async () => {
    provider.behaviour = "timeout";
    const { paymentId, q } = await checkout();
    gw.state = { status: "COMPLETED", amountMinor: q.totalGroup, currency: "INR" };
    await settlePayment(deps, paymentId);
    const b = [...store.bookings.values()][0];
    expect(b.status).toBe("RECONCILIATION_REQUIRED");
    expect(b.externalRef).toBeNull();
  });

  it("failed payment fails the booking and deletes passenger details", async () => {
    const { paymentId } = await checkout();
    gw.state = { status: "FAILED" };
    const p = await settlePayment(deps, paymentId);
    expect(p!.status).toBe("FAILED");
    expect([...store.bookings.values()][0].status).toBe("FAILED");
    expect(store.held.size).toBe(0);
    expect(provider.bookCalls).toBe(0);
  });

  it("gateway outage during reconcile keeps the payment pending", async () => {
    const { paymentId } = await checkout();
    gw.reconcile = async () => { throw new Error("down"); };
    expect((await settlePayment(deps, paymentId))!.status).toBe("PENDING");
  });
});

describe("webhooks and status endpoint", () => {
  it("rejects unauthenticated webhooks without touching anything", async () => {
    const { paymentId, q } = await checkout();
    gw.state = { status: "COMPLETED", amountMinor: q.totalGroup, currency: "INR" };
    gw.webhookOk = false;
    gw.webhookPaymentId = paymentId;
    expect((await handlePaymentWebhook(deps, "phonepe", new Headers(), "{}")).status).toBe(401);
    expect(provider.bookCalls).toBe(0);
  });

  it("an authenticated webhook only triggers a server-side check; a lying body cannot confirm", async () => {
    const { paymentId } = await checkout();
    gw.webhookPaymentId = paymentId; // webhook says "paid" but the gateway API says pending
    expect((await handlePaymentWebhook(deps, "phonepe", new Headers(), '{"payload":{"state":"COMPLETED"}}')).status).toBe(200);
    expect(provider.bookCalls).toBe(0);
    expect([...store.payments.values()][0].status).toBe("PENDING");
  });

  it("webhook for an unknown payment is a harmless no-op", async () => {
    gw.webhookPaymentId = "00000000-0000-4000-8000-0000000000ff";
    expect((await handlePaymentWebhook(deps, "phonepe", new Headers(), "{}")).status).toBe(200);
  });

  it("status polling settles and shows the reference only when truly confirmed", async () => {
    const { paymentId, q } = await checkout();
    let v = await paymentStatus(deps, "alice", paymentId);
    expect(v.status).toBe("PENDING");
    expect(v.bookingReference).toBeNull();
    gw.state = { status: "COMPLETED", amountMinor: q.totalGroup, currency: "INR" };
    v = await paymentStatus(deps, "alice", paymentId);
    expect(v.bookingStatus).toBe("CONFIRMED");
    expect(v.bookingReference).toMatch(/^SBX-/);
  });

  it("another user cannot see someone else's payment", async () => {
    const { paymentId } = await checkout();
    await expect(paymentStatus(deps, "bob", paymentId)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await store.getPayment(paymentId, "bob")).toBeNull();
  });
});

// ------------------------------------------------------------------ real adapters with mocked HTTP
type Call = { url: string; init: RequestInit };
function mockFetch(handler: (url: string, init: RequestInit) => unknown, calls: Call[] = []) {
  const f = vi.fn(async (url: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    const body = handler(String(url), init);
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  });
  return { f: f as unknown as typeof fetch, calls };
}

describe("PhonePe adapter", () => {
  const cfg = { env: "sandbox" as const, clientId: "cid", clientSecret: "sec", clientVersion: "1", webhookUsername: "hookuser", webhookPassword: "hookpass" };

  it("is only built when all credentials exist", () => {
    expect(PhonePeGateway.fromEnv({} as NodeJS.ProcessEnv)).toBeNull();
    expect(PhonePeGateway.fromEnv({ PHONEPE_CLIENT_ID: "a", PHONEPE_CLIENT_SECRET: "b", PHONEPE_WEBHOOK_USERNAME: "c", PHONEPE_WEBHOOK_PASSWORD: "d" } as unknown as NodeJS.ProcessEnv)).not.toBeNull();
  });

  it("enforces the ₹1 minimum and charges paise", () => {
    const g = new PhonePeGateway(cfg);
    expect(g.chargeFor(150_000)).toEqual({ minor: 150_000, currency: "INR", disclosure: null });
    expect(() => g.chargeFor(99)).toThrow();
  });

  it("gets an OAuth token once, then calls /checkout/v2/pay with the paise amount and our order id", async () => {
    const m = mockFetch((url) => url.includes("oauth") ? { access_token: "TOK", expires_at: Math.floor(Date.now() / 1000) + 3600 } : { orderId: "OM123", redirectUrl: "https://mercury.phonepe.test/pay" });
    const g = new PhonePeGateway(cfg, m.f);
    const req = { paymentId: "11111111-1111-4111-8111-111111111111", charge: { minor: 250_000, currency: "INR", disclosure: null }, description: "x", returnUrl: "https://app/ret", cancelUrl: "https://app/c" };
    const out = await g.create(req);
    await g.create(req);
    expect(out).toEqual({ gatewayOrderId: "OM123", redirectUrl: "https://mercury.phonepe.test/pay" });
    expect(m.calls.filter((c) => c.url.includes("oauth"))).toHaveLength(1); // token cached
    const pay = m.calls.find((c) => c.url.endsWith("/checkout/v2/pay"))!;
    expect((pay.init.headers as Record<string, string>).authorization).toBe("O-Bearer TOK");
    const body = JSON.parse(String(pay.init.body));
    expect(body).toMatchObject({ merchantOrderId: req.paymentId, amount: 250_000, paymentFlow: { type: "PG_CHECKOUT", merchantUrls: { redirectUrl: "https://app/ret" } } });
    expect(m.calls[0].url).toContain("pg-sandbox");
    const form = String(m.calls[0].init.body);
    expect(form).toContain("grant_type=client_credentials");
  });

  it("maps order status values", async () => {
    for (const [state, expected] of [["COMPLETED", "COMPLETED"], ["FAILED", "FAILED"], ["PENDING", "PENDING"]] as const) {
      const m = mockFetch((url) => url.includes("oauth") ? { access_token: "T" } : { state, amount: 250_000, paymentDetails: [{ transactionId: "TX9" }] });
      const r = await new PhonePeGateway(cfg, m.f).reconcile({ paymentId: "p-1", gatewayOrderId: "OM1" });
      expect(r.status).toBe(expected);
      expect(r.amountMinor).toBe(250_000);
      expect(m.calls.at(-1)!.url).toContain("/checkout/v2/order/p-1/status");
    }
  });

  it("authenticates webhooks with SHA256(username:password) and rejects anything else", async () => {
    const g = new PhonePeGateway(cfg);
    const good = createHash("sha256").update("hookuser:hookpass").digest("hex");
    const body = JSON.stringify({ event: "checkout.order.completed", payload: { merchantOrderId: "11111111-1111-4111-8111-111111111111", state: "COMPLETED" } });
    expect(await g.verifyWebhook(new Headers({ authorization: good }), body)).toMatchObject({ ok: true, paymentId: "11111111-1111-4111-8111-111111111111" });
    expect((await g.verifyWebhook(new Headers({ authorization: "x".repeat(64) }), body)).ok).toBe(false);
    expect((await g.verifyWebhook(new Headers(), body)).ok).toBe(false);
    expect((await g.verifyWebhook(new Headers({ authorization: good }), "not json")).ok).toBe(false);
    expect((await g.verifyWebhook(new Headers({ authorization: good }), "{}")).ok).toBe(false);
  });
});

describe("PayPal adapter", () => {
  const cfg = { env: "sandbox" as const, clientId: "cid", clientSecret: "sec", webhookId: "WH-1", currency: "USD", inrPerUnit: 85 };

  it("needs credentials and a positive exchange rate", () => {
    expect(PayPalGateway.fromEnv({} as NodeJS.ProcessEnv)).toBeNull();
    expect(PayPalGateway.fromEnv({ PAYPAL_CLIENT_ID: "a", PAYPAL_CLIENT_SECRET: "b", PAYPAL_WEBHOOK_ID: "c" } as unknown as NodeJS.ProcessEnv)).toBeNull(); // no rate
    expect(PayPalGateway.fromEnv({ PAYPAL_CLIENT_ID: "a", PAYPAL_CLIENT_SECRET: "b", PAYPAL_WEBHOOK_ID: "c", PAYPAL_INR_PER_UNIT: "85" } as unknown as NodeJS.ProcessEnv)).not.toBeNull();
  });

  it("converts INR to the charge currency and discloses the rate", () => {
    const c = new PayPalGateway(cfg).chargeFor(850_000); // ₹8,500
    expect(c).toMatchObject({ minor: 10_000, currency: "USD" });
    expect(c.disclosure).toMatch(/USD 100\.00.*₹85/);
    expect(() => new PayPalGateway(cfg).chargeFor(5_000)).toThrow(); // under 1 USD
  });

  it("creates a CAPTURE order with our id as custom_id and returns the approval link", async () => {
    const m = mockFetch((url) => url.includes("oauth2") ? { access_token: "PT", expires_in: 3000 } : { id: "ORD1", status: "PAYER_ACTION_REQUIRED", links: [{ rel: "self", href: "https://x" }, { rel: "payer-action", href: "https://www.sandbox.paypal.com/checkoutnow?token=ORD1" }] });
    const out = await new PayPalGateway(cfg, m.f).create({ paymentId: "pid-1", charge: { minor: 10_000, currency: "USD", disclosure: null }, description: "Travel booking", returnUrl: "https://app/r", cancelUrl: "https://app/c" });
    expect(out).toEqual({ gatewayOrderId: "ORD1", redirectUrl: "https://www.sandbox.paypal.com/checkoutnow?token=ORD1" });
    const tok = m.calls[0];
    expect((tok.init.headers as Record<string, string>).authorization).toBe(`Basic ${Buffer.from("cid:sec").toString("base64")}`);
    const create = m.calls.find((c) => c.url.endsWith("/v2/checkout/orders"))!;
    expect((create.init.headers as Record<string, string>)["paypal-request-id"]).toBe("pid-1");
    const body = JSON.parse(String(create.init.body));
    expect(body.intent).toBe("CAPTURE");
    expect(body.purchase_units[0]).toMatchObject({ custom_id: "pid-1", amount: { currency_code: "USD", value: "100.00" } });
  });

  it("captures an approved order and reports the captured amount", async () => {
    const m = mockFetch((url, init) => {
      if (url.includes("oauth2")) return { access_token: "PT" };
      if (url.endsWith("/capture")) return { id: "ORD1", status: "COMPLETED", purchase_units: [{ payments: { captures: [{ id: "CAP1", status: "COMPLETED", amount: { value: "100.00", currency_code: "USD" } }] } }] };
      return init.method === "POST" ? {} : { id: "ORD1", status: "APPROVED" };
    });
    const r = await new PayPalGateway(cfg, m.f).reconcile({ paymentId: "pid-1", gatewayOrderId: "ORD1" });
    expect(r).toEqual({ status: "COMPLETED", amountMinor: 10_000, currency: "USD", txnId: "CAP1" });
    const cap = m.calls.find((c) => c.url.endsWith("/capture"))!;
    expect((cap.init.headers as Record<string, string>)["paypal-request-id"]).toBe("cap-pid-1");
  });

  it("does not capture orders the buyer has not approved", async () => {
    const m = mockFetch((url) => url.includes("oauth2") ? { access_token: "PT" } : { id: "ORD1", status: "CREATED" });
    expect((await new PayPalGateway(cfg, m.f).reconcile({ paymentId: "p", gatewayOrderId: "ORD1" })).status).toBe("PENDING");
    expect(m.calls.some((c) => c.url.endsWith("/capture"))).toBe(false);
  });

  it("verifies webhooks through PayPal's verifier and extracts our payment id", async () => {
    const m = mockFetch((url) => url.includes("oauth2") ? { access_token: "PT" } : { verification_status: "SUCCESS" });
    const g = new PayPalGateway(cfg, m.f);
    const ev = { id: "WH-EV-1", event_type: "PAYMENT.CAPTURE.COMPLETED", resource: { custom_id: "pid-1", id: "CAP1" } };
    const headers = new Headers({ "paypal-transmission-id": "tid", "paypal-transmission-sig": "sig", "paypal-transmission-time": "t", "paypal-cert-url": "https://api.paypal.com/cert", "paypal-auth-algo": "SHA256withRSA" });
    expect(await g.verifyWebhook(headers, JSON.stringify(ev))).toEqual({ ok: true, eventId: "WH-EV-1", paymentId: "pid-1" });
    const v = JSON.parse(String(m.calls.find((c) => c.url.endsWith("/verify-webhook-signature"))!.init.body));
    expect(v).toMatchObject({ webhook_id: "WH-1", transmission_id: "tid", auth_algo: "SHA256withRSA", webhook_event: ev });
  });

  it("rejects failed verification and incomplete headers", async () => {
    const bad = mockFetch((url) => url.includes("oauth2") ? { access_token: "PT" } : { verification_status: "FAILURE" });
    const headers = new Headers({ "paypal-transmission-id": "tid", "paypal-transmission-sig": "sig" });
    const ev = JSON.stringify({ id: "e", event_type: "X", resource: {} });
    expect((await new PayPalGateway(cfg, bad.f).verifyWebhook(headers, ev)).ok).toBe(false);
    expect((await new PayPalGateway(cfg, bad.f).verifyWebhook(new Headers(), ev)).ok).toBe(false);
  });
});

describe("feature gating", () => {
  const creds = { PHONEPE_CLIENT_ID: "a", PHONEPE_CLIENT_SECRET: "b", PHONEPE_WEBHOOK_USERNAME: "c", PHONEPE_WEBHOOK_PASSWORD: "d" };
  it("stays off unless PAYMENTS_ENABLED=true, even with credentials", () => {
    expect(getGateway("phonepe", creds as unknown as NodeJS.ProcessEnv)).toBeUndefined();
    expect(getGateway("phonepe", { ...creds, PAYMENTS_ENABLED: "true" } as unknown as NodeJS.ProcessEnv)).toBeDefined();
    expect(configuredGateways({ ...creds, PAYMENTS_ENABLED: "true" } as unknown as NodeJS.ProcessEnv)).toEqual(["phonepe"]);
    expect(configuredGateways(creds as unknown as NodeJS.ProcessEnv)).toEqual([]);
  });
});

describe("choosing and ordering gateways", () => {
  const creds = {
    PAYMENTS_ENABLED: "true",
    PHONEPE_CLIENT_ID: "a", PHONEPE_CLIENT_SECRET: "b", PHONEPE_WEBHOOK_USERNAME: "c", PHONEPE_WEBHOOK_PASSWORD: "d",
    PAYPAL_CLIENT_ID: "a", PAYPAL_CLIENT_SECRET: "b", PAYPAL_WEBHOOK_ID: "c", PAYPAL_INR_PER_UNIT: "85",
  };
  const env = (extra: Record<string, string> = {}) => ({ ...creds, ...extra }) as unknown as NodeJS.ProcessEnv;
  it("offers both, PhonePe first, by default", () => {
    expect(configuredGateways(env())).toEqual(["phonepe", "paypal"]);
  });
  it("PAYMENT_GATEWAYS sets the order and acts as an allow-list", () => {
    expect(configuredGateways(env({ PAYMENT_GATEWAYS: "paypal,phonepe" }))).toEqual(["paypal", "phonepe"]);
    expect(configuredGateways(env({ PAYMENT_GATEWAYS: "paypal" }))).toEqual(["paypal"]);
    expect(getGateway("phonepe", env({ PAYMENT_GATEWAYS: "paypal" }))).toBeUndefined(); // cannot be used even though it has credentials
    expect(configuredGateways(env({ PAYMENT_GATEWAYS: "stripe,  PAYPAL" }))).toEqual(["paypal"]); // unknown names are ignored, case-insensitive
  });
  it("a gateway without credentials is never offered", () => {
    const e = { PAYMENTS_ENABLED: "true", PAYPAL_CLIENT_ID: "a", PAYPAL_CLIENT_SECRET: "b", PAYPAL_WEBHOOK_ID: "c", PAYPAL_INR_PER_UNIT: "85" } as unknown as NodeJS.ProcessEnv;
    expect(configuredGateways(e)).toEqual(["paypal"]);
  });
});

describe("HTTP routes", () => {
  beforeEach(() => {
    _resetRateLimits();
    _setStoreForTests(new MemoryStore());
    vi.stubEnv("ALLOW_DEV_AUTH", "true");
    vi.stubEnv("PAYMENTS_ENABLED", "");
  });
  const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
    new Request(`http://localhost${url}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  const body = { gateway: "phonepe", quoteId: "00000000-0000-4000-8000-000000000001", quoteHash: "a".repeat(64), acknowledgedTotal: 1000, acceptedConditions: true, idempotencyKey: "abcdefghijklmnop1234", passengers: [{ fullName: "Test Person", age: 30 }] };

  it("checkout requires sign-in and refuses while payments are off", async () => {
    const { POST } = await import("@/app/api/checkout/route");
    expect([401, 503]).toContain((await POST(post("/api/checkout", body))).status);
    const res = await POST(post("/api/checkout", body, { "x-dev-user-id": "user-a", "x-forwarded-for": "7.7.7.1" }));
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("PAYMENTS_NOT_AVAILABLE");
  });

  it("checkout has no amount field to tamper with and rejects extra junk safely", async () => {
    const { POST } = await import("@/app/api/checkout/route");
    const res = await POST(post("/api/checkout", { ...body, acceptedConditions: false }, { "x-dev-user-id": "user-a", "x-forwarded-for": "7.7.7.2" }));
    expect(res.status).toBe(400);
  });

  it("payment status needs auth and a valid id", async () => {
    const { GET } = await import("@/app/api/payments/[id]/route");
    const anon = await GET(new Request("http://localhost/api/payments/x"), { params: Promise.resolve({ id: "x" }) });
    expect([401, 503]).toContain(anon.status);
    const bad = await GET(new Request("http://localhost/api/payments/x", { headers: { "x-dev-user-id": "user-a" } }), { params: Promise.resolve({ id: "not-a-uuid" }) });
    expect(bad.status).toBe(404);
  });

  it("payment webhooks answer 401 for unknown gateways and when payments are off", async () => {
    const { POST } = await import("@/app/api/payments/webhook/[gateway]/route");
    const unknown = await POST(post("/x", {}), { params: Promise.resolve({ gateway: "stripe" }) });
    expect(unknown.status).toBe(401);
    const off = await POST(post("/x", {}), { params: Promise.resolve({ gateway: "phonepe" }) });
    expect(off.status).toBe(401);
  });
});
