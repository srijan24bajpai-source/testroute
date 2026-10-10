import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { MemoryStore, type Booking, type Payment, type Store } from "@/lib/booking/store";
import { SupabaseStore } from "@/lib/booking/supabase-store";
import { confirmBooking, createQuote, type ConfirmInput, type Deps } from "@/lib/booking/service";
import { settlePayment, startCheckout, type PayDeps } from "@/lib/payments/service";
import { decrypt, encrypt, loadKey } from "@/lib/security/crypto";
import type { CreateRequest, GatewayState, PaymentGateway, WebhookResult } from "@/lib/payments/types";
import { fakeSupabase, FakeDb } from "./fakeSupabase";
import { NOW, SandboxBookingProvider, directItinerary, fareMap, pax } from "./helpers";

const KEY = randomBytes(32);

// The SAME behavioural contract must hold for every Store implementation.
const impls: [string, () => { store: Store; db?: FakeDb }][] = [
  ["MemoryStore", () => ({ store: new MemoryStore() })],
  ["SupabaseStore (emulated PostgREST)", () => { const f = fakeSupabase(); return { store: new SupabaseStore(f.client, KEY), db: f.db }; }],
];

const stamp = NOW.toISOString();
const booking = (over: Partial<Booking> = {}): Booking => ({
  id: "00000000-0000-4000-8000-0000000000b1", userId: "alice", quoteId: "00000000-0000-4000-8000-0000000000a1", providerId: "sandbox",
  status: "PENDING_USER_CONFIRMATION", idempotencyKey: "idem-key-0000000001", externalRef: null, paymentUrl: null, totalGroup: 123_400, currency: "INR",
  passengerCount: 2, segmentIds: ["s1", "s2"], failureReason: null, createdAt: stamp, updatedAt: stamp, ...over,
});
const payment = (over: Partial<Payment> = {}): Payment => ({
  id: "00000000-0000-4000-8000-0000000000c1", userId: "alice", bookingId: "00000000-0000-4000-8000-0000000000b1", gateway: "phonepe",
  amountPaise: 123_400, chargedMinor: 123_400, chargedCurrency: "INR", status: "PENDING", gatewayOrderId: "OM1", gatewayTxnId: null,
  redirectUrl: "https://pay.example.test/x", note: null, createdAt: stamp, updatedAt: stamp, ...over,
});

describe.each(impls)("Store contract: %s", (_name, make) => {
  let store: Store;
  let db: FakeDb | undefined;
  beforeEach(() => ({ store, db } = make()));

  it("quotes: round-trip exactly, and only for their owner", async () => {
    const itin = await directItinerary();
    const provider = new SandboxBookingProvider(fareMap(itin));
    const deps: Deps = { store, now: () => NOW, getBookingProvider: () => provider };
    const q = await createQuote(deps, "alice", itin);
    const back = await store.getQuote(q.id, "alice");
    expect(back).toEqual(q);
    expect(await store.getQuote(q.id, "bob")).toBeNull();
    expect(await store.getQuote("00000000-0000-4000-8000-00000000ffff", "alice")).toBeNull();
  });

  it("bookings: insert is idempotent per user+key and returns the original", async () => {
    const a = await store.insertBookingIfAbsent(booking());
    expect(a.created).toBe(true);
    const again = await store.insertBookingIfAbsent(booking({ id: "00000000-0000-4000-8000-0000000000b2" }));
    expect(again.created).toBe(false);
    expect(again.booking.id).toBe("00000000-0000-4000-8000-0000000000b1");
    const other = await store.insertBookingIfAbsent(booking({ id: "00000000-0000-4000-8000-0000000000b3", userId: "bob" }));
    expect(other.created).toBe(true); // same key, different user is a different booking
  });

  it("bookings: concurrent inserts create exactly one", async () => {
    const res = await Promise.all([store.insertBookingIfAbsent(booking()), store.insertBookingIfAbsent(booking({ id: "00000000-0000-4000-8000-0000000000b9" }))]);
    expect(res.filter((r) => r.created)).toHaveLength(1);
    expect((await store.listBookings("alice"))).toHaveLength(1);
  });

  it("bookings: reads are scoped to the owner", async () => {
    await store.insertBookingIfAbsent(booking());
    expect(await store.getBooking(booking().id, "alice")).not.toBeNull();
    expect(await store.getBooking(booking().id, "bob")).toBeNull();
    expect(await store.listBookings("bob")).toEqual([]);
    expect(await store.getBookingByIdempotency("bob", booking().idempotencyKey)).toBeNull();
  });

  it("bookings: compare-and-set lets exactly one of two racing updates win", async () => {
    await store.insertBookingIfAbsent(booking());
    const [a, b] = await Promise.all([
      store.updateBooking(booking().id, "PENDING_USER_CONFIRMATION", { status: "BOOKING_IN_PROGRESS" }),
      store.updateBooking(booking().id, "PENDING_USER_CONFIRMATION", { status: "FAILED", failureReason: "x" }),
    ]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect(await store.updateBooking(booking().id, "PENDING_USER_CONFIRMATION", { status: "FAILED" })).toBeNull(); // stale expectation
  });

  it("bookings: updates persist provider references and look up by them", async () => {
    await store.insertBookingIfAbsent(booking({ status: "BOOKING_IN_PROGRESS" }));
    const done = await store.updateBooking(booking().id, "BOOKING_IN_PROGRESS", { status: "CONFIRMED", externalRef: "PNR-77" });
    expect(done).toMatchObject({ status: "CONFIRMED", externalRef: "PNR-77", segmentIds: ["s1", "s2"], totalGroup: 123_400 });
    expect((await store.getBookingByExternalRef("sandbox", "PNR-77"))?.id).toBe(booking().id);
    expect(await store.getBookingByExternalRef("sandbox", "nope")).toBeNull();
  });

  it("audit trail keeps order", async () => {
    await store.insertBookingIfAbsent(booking());
    await store.addAudit({ bookingId: booking().id, at: stamp, type: "created", to: "PENDING_USER_CONFIRMATION" });
    await store.addAudit({ bookingId: booking().id, at: stamp, type: "transition", from: "PENDING_USER_CONFIRMATION", to: "BOOKING_IN_PROGRESS" });
    expect((await store.listAudit(booking().id)).map((e) => e.to)).toEqual(["PENDING_USER_CONFIRMATION", "BOOKING_IN_PROGRESS"]);
  });

  it("provider events: a replay is detected", async () => {
    expect(await store.markProviderEvent("p", "e1")).toBe(true);
    expect(await store.markProviderEvent("p", "e1")).toBe(false);
    expect(await store.markProviderEvent("p", "e2")).toBe(true);
    expect(await store.markProviderEvent("q", "e1")).toBe(true);
  });

  it("payments: owner-scoped reads, CAS updates, lookup by booking", async () => {
    await store.insertBookingIfAbsent(booking());
    await store.insertPayment(payment());
    expect(await store.getPayment(payment().id, "alice")).toMatchObject({ status: "PENDING", chargedMinor: 123_400, redirectUrl: "https://pay.example.test/x" });
    expect(await store.getPayment(payment().id, "bob")).toBeNull();
    expect((await store.getPaymentInternal(payment().id))?.userId).toBe("alice");
    expect((await store.getPaymentByBooking(booking().id))?.id).toBe(payment().id);
    const [a, b] = await Promise.all([
      store.updatePayment(payment().id, "PENDING", { status: "COMPLETED", gatewayTxnId: "TX1" }),
      store.updatePayment(payment().id, "PENDING", { status: "FAILED" }),
    ]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect(await store.updatePayment(payment().id, "PENDING", { status: "FAILED" })).toBeNull();
  });

  it("passenger details can be taken exactly once", async () => {
    await store.holdPassengers("00000000-0000-4000-8000-0000000000b1", pax);
    const [x, y] = await Promise.all([store.takePassengers("00000000-0000-4000-8000-0000000000b1"), store.takePassengers("00000000-0000-4000-8000-0000000000b1")]);
    expect([x, y].filter(Boolean)).toHaveLength(1);
    expect(await store.takePassengers("00000000-0000-4000-8000-0000000000b1")).toBeNull();
  });

  it("trips: save, list newest-first, owner-only delete", async () => {
    await store.saveTrip({ id: "00000000-0000-4000-8000-0000000000d1", userId: "alice", title: "Old", constraints: { a: 1 }, createdAt: "2026-01-01T00:00:00Z" });
    await store.saveTrip({ id: "00000000-0000-4000-8000-0000000000d2", userId: "alice", title: "New", constraints: { b: 2 }, createdAt: "2026-02-01T00:00:00Z" });
    expect((await store.listTrips("alice")).map((t) => t.title).sort()).toEqual(["New", "Old"]);
    expect(await store.listTrips("bob")).toEqual([]);
    expect(await store.deleteTrip("00000000-0000-4000-8000-0000000000d1", "bob")).toBe(false);
    expect(await store.deleteTrip("00000000-0000-4000-8000-0000000000d1", "alice")).toBe(true);
    expect(await store.listTrips("alice")).toHaveLength(1);
  });

  it("erasure removes trips and loose quotes but keeps booking records", async () => {
    const itin = await directItinerary();
    const provider = new SandboxBookingProvider(fareMap(itin));
    const deps: Deps = { store, now: () => NOW, getBookingProvider: () => provider };
    const used = await createQuote(deps, "alice", itin);
    await createQuote(deps, "alice", itin); // a second, unused quote
    await store.insertBookingIfAbsent(booking({ quoteId: used.id }));
    await store.saveTrip({ id: "00000000-0000-4000-8000-0000000000d1", userId: "alice", title: "T", constraints: {}, createdAt: stamp });
    const r = await store.eraseUser("alice");
    expect(r).toEqual({ deletedTrips: 1, retainedBookings: 1 });
    expect(await store.listTrips("alice")).toEqual([]);
    expect((await store.exportUser("alice")).quotes.map((q) => q.id)).toEqual([used.id]); // only the quote a booking points at remains
    expect((await store.exportUser("alice")).bookings).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------------------
describe("SupabaseStore specifics", () => {
  it("encrypts passenger names at rest (no plaintext in the table) and ignores tampered or expired rows", async () => {
    const f = fakeSupabase();
    const store = new SupabaseStore(f.client, KEY);
    await store.holdPassengers("b1", [{ fullName: "Secret Name", age: 41 }]);
    const raw = JSON.stringify(f.db.rows("booking_passengers_tmp"));
    expect(raw).not.toContain("Secret");
    expect(raw).toContain("\\\\x"); // stored as a bytea hex string

    // tamper: flip a byte in the ciphertext
    const row = f.db.rows("booking_passengers_tmp")[0];
    const hex = String(row.payload_encrypted).slice(2);
    const flipped = hex.slice(0, 60) + (hex[60] === "0" ? "1" : "0") + hex.slice(61);
    row.payload_encrypted = `\\x${flipped}`;
    expect(await store.takePassengers("b1")).toBeNull();

    // expired rows are treated as gone
    await store.holdPassengers("b2", [{ fullName: "Another", age: 30 }]);
    f.db.rows("booking_passengers_tmp").find((r) => r.booking_id === "b2")!.expires_at = new Date(Date.now() - 1000).toISOString();
    expect(await store.takePassengers("b2")).toBeNull();
  });

  it("a different key cannot read the data", async () => {
    const f = fakeSupabase();
    await new SupabaseStore(f.client, KEY).holdPassengers("b1", [{ fullName: "X Y", age: 5 }]);
    expect(await new SupabaseStore(f.client, randomBytes(32)).takePassengers("b1")).toBeNull();
  });

  it("surfaces database errors instead of swallowing them", async () => {
    const broken = { from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: { message: "connection refused" } }) }) }) }) }) } as never;
    await expect(new SupabaseStore(broken, KEY).getQuote("q", "u")).rejects.toThrow(/connection refused/);
  });
});

describe("crypto helpers", () => {
  it("round-trips, authenticates, and validates the key", () => {
    const blob = encrypt("hello ₹", KEY);
    expect(decrypt(blob, KEY)).toBe("hello ₹");
    expect(encrypt("hello ₹", KEY).equals(blob)).toBe(false); // fresh IV each time
    const bad = Buffer.from(blob); bad[bad.length - 1] ^= 1;
    expect(() => decrypt(bad, KEY)).toThrow();
    expect(() => decrypt(Buffer.from("short"), KEY)).toThrow();
    expect(() => loadKey({ PASSENGER_DATA_KEY: "" } as unknown as NodeJS.ProcessEnv)).toThrow(/32 random bytes/);
    expect(loadKey({ PASSENGER_DATA_KEY: KEY.toString("base64") } as unknown as NodeJS.ProcessEnv).equals(KEY)).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------
// The whole booking and payment flows must behave identically on the durable store.
class FakeGateway implements PaymentGateway {
  readonly id = "phonepe" as const;
  state: GatewayState = { status: "PENDING" };
  chargeFor(p: number) { return { minor: p, currency: "INR", disclosure: null }; }
  async create(req: CreateRequest) { return { gatewayOrderId: `GW-${req.paymentId}`, redirectUrl: `https://pay.example.test/${req.paymentId}` }; }
  async reconcile() { return this.state; }
  async verifyWebhook(): Promise<WebhookResult> { return { ok: false }; }
}

describe("end-to-end flows on the Supabase store", () => {
  let n = 0;
  const ids = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
  const input = (q: { id: string; hash: string; totalGroup: number }): ConfirmInput => ({ quoteId: q.id, quoteHash: q.hash, acknowledgedTotal: q.totalGroup, acceptedConditions: true, idempotencyKey: "idem-key-0000000001", passengers: pax });

  it("booking: confirm once, double-click safe, reference stored", async () => {
    n = 0;
    const store = new SupabaseStore(fakeSupabase().client, KEY);
    const itin = await directItinerary();
    const provider = new SandboxBookingProvider(fareMap(itin));
    const deps: Deps = { store, now: () => NOW, id: ids, getBookingProvider: () => provider };
    const q = await createQuote(deps, "alice", itin);
    const [a, b] = await Promise.all([confirmBooking(deps, "alice", input(q)), confirmBooking(deps, "alice", input(q))]);
    expect(provider.bookCalls).toBe(1);
    expect([a, b].map((r) => r.kind)).toEqual(["booking", "booking"]);
    const list = await store.listBookings("alice");
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ status: "CONFIRMED", externalRef: expect.stringMatching(/^SBX-/) });
  });

  it("payment: pay-then-book buys exactly once and deletes the passenger row", async () => {
    n = 0;
    const f = fakeSupabase();
    const store = new SupabaseStore(f.client, KEY);
    const itin = await directItinerary();
    const provider = new SandboxBookingProvider(fareMap(itin));
    const gw = new FakeGateway();
    const deps: PayDeps = { store, now: () => NOW, id: ids, origin: "https://app.example.test", getBookingProvider: () => provider, gateway: () => gw };
    const q = await createQuote(deps, "alice", itin);
    const out = await startCheckout(deps, "alice", input(q), "phonepe");
    if (out.kind !== "redirect") throw new Error("expected redirect");
    expect(f.db.rows("booking_passengers_tmp")).toHaveLength(1);
    expect(JSON.stringify(f.db.tables.get("booking_passengers_tmp"))).not.toContain("Traveller");
    gw.state = { status: "COMPLETED", amountMinor: q.totalGroup, currency: "INR", txnId: "TX9" };
    await Promise.all([settlePayment(deps, out.payment.id), settlePayment(deps, out.payment.id)]);
    expect(provider.bookCalls).toBe(1);
    expect((await store.listBookings("alice"))[0].status).toBe("CONFIRMED");
    expect((await store.getPaymentInternal(out.payment.id))?.status).toBe("COMPLETED");
    expect(f.db.rows("booking_passengers_tmp")).toHaveLength(0);
  });
});
