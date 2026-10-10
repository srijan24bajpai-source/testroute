import { beforeEach, describe, expect, it } from "vitest";
import { MemoryStore } from "@/lib/booking/store";
import {
  BookingError, applyProviderEvent, confirmBooking, createQuote, reconcileBooking, requestCancel, signWebhook, verifyWebhook,
  type ConfirmInput, type Deps,
} from "@/lib/booking/service";
import { IllegalTransition, assertTransition, canTransition, isTrulyConfirmed } from "@/lib/booking/state";
import { NOW, SandboxBookingProvider, directItinerary, fareMap, pax } from "./helpers";
import type { Itinerary } from "@/lib/domain/types";

let store: MemoryStore;
let provider: SandboxBookingProvider;
let deps: Deps;
let itin: Itinerary;
let counter = 0;

beforeEach(async () => {
  store = new MemoryStore();
  itin = await directItinerary();
  provider = new SandboxBookingProvider(fareMap(itin));
  counter = 0;
  deps = { store, getBookingProvider: (id) => (id === "sandbox" ? provider : undefined), now: () => NOW, id: () => `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}` };
});

const input = (q: { id: string; hash: string; totalGroup: number }, over: Partial<ConfirmInput> = {}): ConfirmInput => ({
  quoteId: q.id, quoteHash: q.hash, acknowledgedTotal: q.totalGroup, acceptedConditions: true,
  idempotencyKey: "idem-key-0000000001", passengers: pax, ...over,
});

describe("quotes", () => {
  it("binds the quote to user, segments, amount and conditions", async () => {
    const q = await createQuote(deps, "alice", itin);
    expect(q.totalGroup).toBe(provider.priceDelta + itin.cost.expectedGroup);
    expect(q.hash).toHaveLength(64);
    const q2 = await createQuote(deps, "bob", itin);
    expect(q2.hash).not.toBe(q.hash);
  });
});

describe("booking happy path and gates", () => {
  it("confirms only with a provider reference and records an audit trail", async () => {
    const q = await createQuote(deps, "alice", itin);
    const out = await confirmBooking(deps, "alice", input(q));
    expect(out.kind).toBe("booking");
    if (out.kind !== "booking") return;
    expect(out.booking.status).toBe("CONFIRMED");
    expect(isTrulyConfirmed(out.booking)).toBe(true);
    const trail = (await store.listAudit(out.booking.id)).map((a) => a.to);
    expect(trail).toEqual(["PENDING_USER_CONFIRMATION", "BOOKING_IN_PROGRESS", "CONFIRMED"]);
    expect(JSON.stringify(store.audit)).not.toContain("Traveller");
  });

  it("never stores passenger names", async () => {
    const q = await createQuote(deps, "alice", itin);
    await confirmBooking(deps, "alice", input(q));
    expect(JSON.stringify([...store.bookings.values()])).not.toContain("Traveller");
  });

  it("refuses demo/search-only itineraries: no booking row, no provider call", async () => {
    const demo = await directItinerary("DEMO_ONLY");
    const q = await createQuote(deps, "alice", demo);
    await expect(confirmBooking(deps, "alice", input(q))).rejects.toMatchObject({ code: "BOOKING_NOT_AVAILABLE" });
    expect(store.bookings.size).toBe(0);
    expect(provider.bookCalls).toBe(0);
  });

  it.each([
    ["wrong hash", { quoteHash: "a".repeat(64) }, "QUOTE_CHANGED"],
    ["wrong amount", { acknowledgedTotal: 1 }, "AMOUNT_MISMATCH"],
    ["conditions not accepted", { acceptedConditions: false }, "CONDITIONS_NOT_ACCEPTED"],
    ["wrong passenger count", { passengers: [pax[0]] }, "PASSENGER_COUNT"],
  ])("rejects %s", async (_n, over, code) => {
    const q = await createQuote(deps, "alice", itin);
    await expect(confirmBooking(deps, "alice", input(q, over as Partial<ConfirmInput>))).rejects.toMatchObject({ code });
    expect(provider.bookCalls).toBe(0);
  });

  it("rejects expired quotes", async () => {
    const q = await createQuote(deps, "alice", itin);
    const later: Deps = { ...deps, now: () => new Date(NOW.getTime() + 11 * 60_000) };
    await expect(confirmBooking(later, "alice", input(q))).rejects.toMatchObject({ code: "QUOTE_EXPIRED" });
  });
});

describe("duplicate prevention", () => {
  it("double-clicks (concurrent same key) hit the provider once", async () => {
    const q = await createQuote(deps, "alice", itin);
    const [a, b] = await Promise.all([confirmBooking(deps, "alice", input(q)), confirmBooking(deps, "alice", input(q))]);
    expect(provider.bookCalls).toBe(1);
    expect(store.bookings.size).toBe(1);
    expect([a, b].filter((r) => r.kind === "booking" && r.replay).length).toBe(1);
  });

  it("a later retry with the same key replays instead of booking again", async () => {
    const q = await createQuote(deps, "alice", itin);
    await confirmBooking(deps, "alice", input(q));
    const again = await confirmBooking(deps, "alice", input(q));
    expect(again.kind === "booking" && again.replay).toBe(true);
    expect(provider.bookCalls).toBe(1);
  });

  it("reusing a key for a different quote is rejected", async () => {
    const q1 = await createQuote(deps, "alice", itin);
    await confirmBooking(deps, "alice", input(q1));
    const q2 = await createQuote(deps, "alice", itin);
    await expect(confirmBooking(deps, "alice", input(q2))).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });
});

describe("fare change before checkout", () => {
  it("requires a fresh confirmation and does not book", async () => {
    const q = await createQuote(deps, "alice", itin);
    provider.priceDelta = 50_000;
    const out = await confirmBooking(deps, "alice", input(q));
    expect(out.kind).toBe("requote");
    if (out.kind !== "requote") return;
    expect(out.booking.status).toBe("QUOTE_REFRESH_REQUIRED");
    expect(out.quote.totalGroup).toBeGreaterThan(q.totalGroup);
    expect(out.quote.hash).not.toBe(q.hash);
    expect(provider.bookCalls).toBe(0);
    // The user must confirm the NEW quote/amount explicitly.
    const ok = await confirmBooking(deps, "alice", input(out.quote, { idempotencyKey: "idem-key-0000000002" }));
    expect(ok.kind === "booking" && ok.booking.status).toBe("CONFIRMED");
  });
});

describe("unknown outcomes", () => {
  it("timeout → RECONCILIATION_REQUIRED, never blindly retried, then reconciled via lookup", async () => {
    provider.behaviour = "timeout";
    const q = await createQuote(deps, "alice", itin);
    const out = await confirmBooking(deps, "alice", input(q));
    expect(out.kind === "booking" && out.booking.status).toBe("RECONCILIATION_REQUIRED");
    expect(provider.bookCalls).toBe(1);
    // client retries: replay, no second purchase attempt
    await confirmBooking(deps, "alice", input(q));
    expect(provider.bookCalls).toBe(1);
    const id = out.kind === "booking" ? out.booking.id : "";
    const settled = await reconcileBooking(deps, "alice", id);
    expect(settled.status).toBe("CONFIRMED");
    expect(settled.externalRef).toBe("SBX-LATE-1");
    expect(provider.bookCalls).toBe(1);
  });

  it("a 'confirmed' answer without a reference is not a confirmation", async () => {
    provider.behaviour = "noref";
    const q = await createQuote(deps, "alice", itin);
    const out = await confirmBooking(deps, "alice", input(q));
    expect(out.kind === "booking" && out.booking.status).toBe("RECONCILIATION_REQUIRED");
  });

  it("provider decline → FAILED with reason", async () => {
    provider.behaviour = "decline";
    const q = await createQuote(deps, "alice", itin);
    const out = await confirmBooking(deps, "alice", input(q));
    expect(out.kind === "booking" && out.booking.status).toBe("FAILED");
  });
});

describe("payment pending and webhooks", () => {
  const secret = "whsec_test_not_real";
  it("payment success without a booking reference does not confirm; with one it does; replays are ignored", async () => {
    provider.behaviour = "pending";
    const q = await createQuote(deps, "alice", itin);
    const out = await confirmBooking(deps, "alice", input(q));
    expect(out.kind === "booking" && out.booking.status).toBe("PAYMENT_PENDING");
    const noRef = await applyProviderEvent(deps, "sandbox", { id: "e1", type: "payment.succeeded", externalRef: "SBX-PEND-1" });
    expect(noRef.applied).toBe(false);
    expect([...store.bookings.values()][0].status).toBe("PAYMENT_PENDING");
    const ok = await applyProviderEvent(deps, "sandbox", { id: "e2", type: "booking.confirmed", externalRef: "SBX-PEND-1", bookingRef: "PNR-9" });
    expect(ok.applied).toBe(true);
    const b = [...store.bookings.values()][0];
    expect(b.status).toBe("CONFIRMED");
    expect(b.externalRef).toBe("PNR-9");
    const replay = await applyProviderEvent(deps, "sandbox", { id: "e2", type: "booking.confirmed", externalRef: "SBX-PEND-1", bookingRef: "PNR-9" });
    expect(replay).toEqual({ applied: false, reason: "replay" });
  });

  it("verifies signatures and the replay window", () => {
    const body = JSON.stringify({ id: "e1" });
    const ts = String(Math.floor(NOW.getTime() / 1000));
    const sig = signWebhook(secret, ts, body);
    expect(verifyWebhook(secret, ts, sig, body, NOW.getTime())).toBe(true);
    expect(verifyWebhook(secret, ts, sig, body + " ", NOW.getTime())).toBe(false);
    expect(verifyWebhook("other", ts, sig, body, NOW.getTime())).toBe(false);
    expect(verifyWebhook(secret, ts, "zz", body, NOW.getTime())).toBe(false);
    expect(verifyWebhook(secret, ts, sig, body, NOW.getTime() + 10 * 60_000)).toBe(false);
  });
});

describe("cancellation", () => {
  it("is actionable only when the provider supports it", async () => {
    const q = await createQuote(deps, "alice", itin);
    const out = await confirmBooking(deps, "alice", input(q));
    const id = out.kind === "booking" ? out.booking.id : "";
    const done = await requestCancel(deps, "alice", id);
    expect(done.actionable).toBe(true);
    expect(done.booking.status).toBe("REFUND_PENDING");
    expect(done.message).toMatch(/no refund amount is guaranteed/i);
  });

  it("explains the provider channel when unsupported", async () => {
    provider.capability = "QUOTE_AND_BOOK";
    const q = await createQuote(deps, "alice", itin);
    const out = await confirmBooking(deps, "alice", input(q));
    const id = out.kind === "booking" ? out.booking.id : "";
    const r = await requestCancel(deps, "alice", id);
    expect(r.actionable).toBe(false);
    expect(r.booking.status).toBe("CONFIRMED");
  });
});

describe("cross-user isolation (IDOR)", () => {
  it("user B cannot see, confirm, cancel or list user A's records", async () => {
    const q = await createQuote(deps, "alice", itin);
    const out = await confirmBooking(deps, "alice", input(q));
    const id = out.kind === "booking" ? out.booking.id : "";
    expect(await store.getQuote(q.id, "bob")).toBeNull();
    expect(await store.getBooking(id, "bob")).toBeNull();
    expect(await store.listBookings("bob")).toEqual([]);
    await expect(confirmBooking(deps, "bob", input(q, { idempotencyKey: "bob-key-0000000001" }))).rejects.toMatchObject({ code: "QUOTE_NOT_FOUND" });
    await expect(requestCancel(deps, "bob", id)).rejects.toBeInstanceOf(BookingError);
    await expect(reconcileBooking(deps, "bob", id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    // idempotency keys are per-user: Bob reusing Alice's key does not return her booking
    expect(await store.getBookingByIdempotency("bob", "idem-key-0000000001")).toBeNull();
  });
});

describe("state machine", () => {
  it("rejects illegal transitions", () => {
    expect(canTransition("DRAFT", "CONFIRMED")).toBe(false);
    expect(() => assertTransition("CANCELLED", "CONFIRMED")).toThrow(IllegalTransition);
    expect(() => assertTransition("FAILED", "BOOKING_IN_PROGRESS")).toThrow(IllegalTransition);
    expect(canTransition("BOOKING_IN_PROGRESS", "CONFIRMED")).toBe(true);
    expect(isTrulyConfirmed({ status: "CONFIRMED", externalRef: null })).toBe(false);
  });
});

describe("data lifecycle", () => {
  it("exports and erases user data while retaining minimal booking rows", async () => {
    const q = await createQuote(deps, "alice", itin);
    await confirmBooking(deps, "alice", input(q));
    await store.saveTrip({ id: "t1", userId: "alice", title: "x", constraints: {}, createdAt: NOW.toISOString() });
    expect((await store.exportUser("alice")).trips).toHaveLength(1);
    const r = await store.eraseUser("alice");
    expect(r).toEqual({ deletedTrips: 1, retainedBookings: 1 });
    expect(await store.listTrips("alice")).toEqual([]);
  });
});
