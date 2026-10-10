import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { searchConfig } from "@/config/brand";
import type { Itinerary } from "../domain/types";
import type { BookingPassenger, BookingProvider, ProviderBookResult } from "../providers/types";
import { assertTransition, type BookingStatus } from "./state";
import type { Booking, Quote, Store } from "./store";

export class BookingError extends Error {
  constructor(public code: string, message: string, public httpStatus = 400, public extra?: Record<string, unknown>) {
    super(message);
  }
}

export interface Deps {
  store: Store;
  /** Returns a live booking adapter, or undefined if the provider cannot book in-app. */
  getBookingProvider: (providerId: string) => BookingProvider | undefined;
  now?: () => Date;
  id?: () => string;
}

const nowOf = (d: Deps) => (d.now ?? (() => new Date()))();
const idOf = (d: Deps) => (d.id ?? randomUUID)();

export const CONDITIONS = [
  "Fares are re-checked with the provider at the moment of purchase and may change.",
  "Each leg of a multi-leg trip is a separate ticket; a delay or cancellation on one leg does not protect the others.",
  "Refund and cancellation rules are set by each provider; unless a provider confirms otherwise, assume tickets may be non-refundable.",
];

export function quoteHash(q: Pick<Quote, "userId" | "providerId" | "segmentIds" | "passengers" | "totalGroup" | "currency" | "conditions">, fareVersion = ""): string {
  return createHash("sha256")
    .update(JSON.stringify([q.userId, q.providerId, q.segmentIds, q.passengers, q.totalGroup, q.currency, q.conditions, fareVersion]))
    .digest("hex");
}

/** Capability is derived server-side from the segments: every ticketed leg must be bookable by ONE provider. */
export function deriveCapability(it: Itinerary): { providerId: string; capability: string } {
  const legs = it.segments.filter((s) => s.mode !== "ground");
  const providers = new Set(legs.map((s) => s.provider));
  const caps = new Set(legs.map((s) => s.capability));
  if (providers.size !== 1) return { providerId: [...providers].join("+"), capability: caps.has("DEMO_ONLY") ? "DEMO_ONLY" : "SEARCH_ONLY" };
  const capability = caps.size === 1 ? [...caps][0] : "SEARCH_ONLY";
  return { providerId: legs[0].provider, capability };
}

export async function createQuote(deps: Deps, userId: string, it: Itinerary): Promise<Quote> {
  const now = nowOf(deps);
  const { providerId, capability } = deriveCapability(it);
  let totalGroup = it.cost.expectedGroup;
  let fareVersion = "";
  // If a live booking adapter exists, re-price with the provider now; this is the authoritative fare.
  const adapter = deps.getBookingProvider(providerId);
  if (adapter && (capability === "QUOTE_AND_BOOK" || capability === "CANCEL_SUPPORTED")) {
    const pq = await adapter.refreshQuote(it.segments.filter((s) => s.mode !== "ground").map((s) => s.id), it.cost.passengers);
    totalGroup = pq.totalPerPerson * it.cost.passengers + it.cost.estimatedPerPerson * it.cost.passengers;
    fareVersion = pq.fareVersion;
  }
  const segmentIds = it.segments.filter((s) => s.mode !== "ground").map((s) => s.id);
  const base = {
    id: idOf(deps),
    userId,
    providerId,
    segmentIds,
    passengers: it.cost.passengers,
    totalPerPerson: Math.round(totalGroup / it.cost.passengers),
    totalGroup,
    currency: "INR" as const,
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + searchConfig.quoteTtlMinutes * 60_000).toISOString(),
    itinerary: it,
    conditions: CONDITIONS,
    capability,
  };
  const quote: Quote = { ...base, hash: quoteHash(base, fareVersion) };
  await deps.store.saveQuote(quote);
  return quote;
}

export interface ConfirmInput {
  quoteId: string;
  quoteHash: string;
  acknowledgedTotal: number; // paise – the exact amount the user saw
  acceptedConditions: boolean;
  idempotencyKey: string;
  passengers: BookingPassenger[];
}

export type ConfirmResult =
  | { kind: "booking"; booking: Booking; replay: boolean }
  | { kind: "requote"; booking: Booking; quote: Quote };

export async function transition(deps: Deps, b: Booking, to: BookingStatus, patch: Partial<Booking> = {}, note?: string): Promise<Booking> {
  assertTransition(b.status, to);
  const next = await deps.store.updateBooking(b.id, b.status, { ...patch, status: to });
  if (!next) throw new BookingError("CONCURRENT_UPDATE", "Booking was changed by another request.", 409);
  await deps.store.addAudit({ bookingId: b.id, at: nowOf(deps).toISOString(), type: "transition", from: b.status, to, note });
  return next;
}

export function applyResult(deps: Deps, b: Booking, r: ProviderBookResult): Promise<Booking> {
  switch (r.outcome) {
    case "CONFIRMED":
      // A confirmation without a provider reference is NOT a confirmation.
      return r.externalRef
        ? transition(deps, b, "CONFIRMED", { externalRef: r.externalRef })
        : transition(deps, b, "RECONCILIATION_REQUIRED", {}, "confirmed without reference");
    case "PAYMENT_PENDING":
      return transition(deps, b, "PAYMENT_PENDING", { paymentUrl: r.paymentUrl, externalRef: r.externalRef ?? null });
    case "DECLINED":
      return transition(deps, b, "FAILED", { failureReason: r.reason.slice(0, 200) });
    default:
      return transition(deps, b, "RECONCILIATION_REQUIRED", {}, "unknown provider outcome");
  }
}

/** Shared pre-purchase gates: ownership, expiry, hash, exact amount, consent, passenger count, capability. */
export async function checkQuote(deps: Deps, userId: string, input: ConfirmInput): Promise<{ quote: Quote; adapter: BookingProvider }> {
  const now = nowOf(deps);
  const quote = await deps.store.getQuote(input.quoteId, userId);
  if (!quote) throw new BookingError("QUOTE_NOT_FOUND", "Quote not found.", 404);
  if (new Date(quote.expiresAt) <= now) throw new BookingError("QUOTE_EXPIRED", "This quote has expired. Please review a fresh quote.", 409);
  if (quote.hash !== input.quoteHash) throw new BookingError("QUOTE_CHANGED", "The itinerary or price changed. Please review the new details.", 409);
  if (input.acknowledgedTotal !== quote.totalGroup) throw new BookingError("AMOUNT_MISMATCH", "The confirmed amount does not match the quote.", 409);
  if (!input.acceptedConditions) throw new BookingError("CONDITIONS_NOT_ACCEPTED", "You must accept the fare conditions.", 400);
  if (input.passengers.length !== quote.passengers) throw new BookingError("PASSENGER_COUNT", "Passenger details must match the quoted passenger count.", 400);

  const adapter = deps.getBookingProvider(quote.providerId);
  if (!adapter || quote.capability === "DEMO_ONLY" || quote.capability === "SEARCH_ONLY") {
    throw new BookingError(
      "BOOKING_NOT_AVAILABLE",
      "In-app booking is not available for this itinerary. No ticket has been issued and nothing was charged. Use the provider's official booking channel.",
      422,
    );
  }
  return { quote, adapter };
}

export async function confirmBooking(deps: Deps, userId: string, input: ConfirmInput): Promise<ConfirmResult> {
  const now = nowOf(deps);
  // Idempotent replay first: a double-click returns the same booking, never a second attempt.
  const prior = await deps.store.getBookingByIdempotency(userId, input.idempotencyKey);
  if (prior) {
    if (prior.quoteId !== input.quoteId) throw new BookingError("IDEMPOTENCY_CONFLICT", "This idempotency key was used for a different quote.", 409);
    return { kind: "booking", booking: prior, replay: true };
  }

  const { quote, adapter } = await checkQuote(deps, userId, input);

  const stamp = now.toISOString();
  const { booking: created, created: isNew } = await deps.store.insertBookingIfAbsent({
    id: idOf(deps), userId, quoteId: quote.id, providerId: quote.providerId, status: "PENDING_USER_CONFIRMATION",
    idempotencyKey: input.idempotencyKey, externalRef: null, paymentUrl: null, totalGroup: quote.totalGroup, currency: "INR",
    passengerCount: quote.passengers, segmentIds: quote.segmentIds, failureReason: null, createdAt: stamp, updatedAt: stamp,
  });
  if (!isNew) return { kind: "booking", booking: created, replay: true };
  await deps.store.addAudit({ bookingId: created.id, at: stamp, type: "created", to: "PENDING_USER_CONFIRMATION" });

  // Re-price immediately before purchase.
  const fresh = await adapter.refreshQuote(quote.segmentIds, quote.passengers);
  const freshGroup = fresh.totalPerPerson * quote.passengers + Math.round(quote.itinerary.cost.estimatedPerPerson * quote.passengers);
  if (freshGroup !== quote.totalGroup) {
    const requoted = await createQuote(deps, userId, quote.itinerary);
    const b = await transition(deps, created, "QUOTE_REFRESH_REQUIRED", {}, "price changed before checkout");
    return { kind: "requote", booking: b, quote: requoted };
  }

  // Compare-and-set: only one concurrent request can move to BOOKING_IN_PROGRESS.
  const inProgress = await transition(deps, created, "BOOKING_IN_PROGRESS");
  let result: ProviderBookResult;
  try {
    result = await adapter.book({ segmentIds: quote.segmentIds, passengers: input.passengers, expectedTotal: quote.totalGroup, idempotencyKey: input.idempotencyKey });
  } catch {
    result = { outcome: "UNKNOWN" }; // timeout/network: never retried blindly
  }
  const booking = await applyResult(deps, inProgress, result);
  return { kind: "booking", booking, replay: false };
}

/** Resolve uncertain outcomes by asking the provider (never by re-submitting a purchase). */
export async function reconcileBooking(deps: Deps, userId: string, bookingId: string): Promise<Booking> {
  const b = await deps.store.getBooking(bookingId, userId);
  if (!b) throw new BookingError("NOT_FOUND", "Booking not found.", 404);
  if (b.status !== "RECONCILIATION_REQUIRED" && b.status !== "PAYMENT_PENDING") return b;
  const adapter = deps.getBookingProvider(b.providerId);
  if (!adapter) return b;
  let r: ProviderBookResult;
  try {
    r = await adapter.lookup(b.idempotencyKey);
  } catch {
    return b; // still unknown; try again on the next reconciliation run
  }
  if (r.outcome === "UNKNOWN") return b;
  if (r.outcome === "PAYMENT_PENDING" && b.status === "PAYMENT_PENDING") return b;
  return applyResult(deps, b, r);
}

export async function requestCancel(deps: Deps, userId: string, bookingId: string): Promise<{ actionable: boolean; message: string; booking: Booking }> {
  const b = await deps.store.getBooking(bookingId, userId);
  if (!b) throw new BookingError("NOT_FOUND", "Booking not found.", 404);
  const adapter = deps.getBookingProvider(b.providerId);
  if (b.status !== "CONFIRMED" || !b.externalRef) return { actionable: false, message: "Only confirmed bookings can be cancelled.", booking: b };
  if (!adapter?.cancel || adapter.capability !== "CANCEL_SUPPORTED") {
    return { actionable: false, message: "This provider does not support cancellation here. Please contact the provider directly using your booking reference.", booking: b };
  }
  const requested = await transition(deps, b, "CANCEL_REQUESTED");
  let out: "CANCELLED" | "REFUND_PENDING" | "REJECTED";
  try {
    out = (await adapter.cancel(b.externalRef)).outcome;
  } catch {
    out = "REJECTED";
  }
  if (out === "REJECTED") {
    const back = await transition(deps, requested, "CONFIRMED", {}, "cancellation not accepted by provider");
    return { actionable: true, message: "The provider did not accept the cancellation. Your booking remains confirmed.", booking: back };
  }
  const done = await transition(deps, requested, out);
  return { actionable: true, message: out === "CANCELLED" ? "Booking cancelled." : "Cancellation accepted; refund is pending with the provider. No refund amount is guaranteed.", booking: done };
}

// ---- provider webhooks ------------------------------------------------------------------
export function signWebhook(secret: string, timestamp: string, rawBody: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
}

export function verifyWebhook(secret: string, timestamp: string, signature: string, rawBody: string, nowMs = Date.now(), toleranceMs = 5 * 60_000): boolean {
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(nowMs - ts * 1000) > toleranceMs) return false; // replay window
  const expected = Buffer.from(signWebhook(secret, timestamp, rawBody), "hex");
  let given: Buffer;
  try {
    given = Buffer.from(signature, "hex");
  } catch {
    return false;
  }
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export interface ProviderEvent {
  id: string;
  type: "payment.succeeded" | "payment.failed" | "booking.confirmed" | "booking.failed" | "booking.cancelled";
  externalRef: string;
  bookingRef?: string; // provider-issued confirmed booking/ticket reference
}

/** Applies a signature-verified event. Idempotent: replays are ignored. */
export async function applyProviderEvent(deps: Deps, providerId: string, ev: ProviderEvent): Promise<{ applied: boolean; reason?: string }> {
  if (!(await deps.store.markProviderEvent(providerId, ev.id))) return { applied: false, reason: "replay" };
  const b = await deps.store.getBookingByExternalRef(providerId, ev.externalRef);
  if (!b) return { applied: false, reason: "unknown booking" };
  const note = ev.type;
  if (ev.type === "booking.confirmed" || ev.type === "payment.succeeded") {
    // Payment alone is not a ticket: require the provider's own confirmed reference.
    if (!ev.bookingRef) {
      await deps.store.addAudit({ bookingId: b.id, at: nowOf(deps).toISOString(), type: "event", note: `${note} without booking reference; not confirmed` });
      return { applied: false, reason: "no booking reference" };
    }
    if (b.status === "PAYMENT_PENDING" || b.status === "RECONCILIATION_REQUIRED") {
      await transition(deps, b, "CONFIRMED", { externalRef: ev.bookingRef }, note);
      return { applied: true };
    }
  } else if ((ev.type === "payment.failed" || ev.type === "booking.failed") && (b.status === "PAYMENT_PENDING" || b.status === "RECONCILIATION_REQUIRED")) {
    await transition(deps, b, "FAILED", { failureReason: ev.type }, note);
    return { applied: true };
  } else if (ev.type === "booking.cancelled" && b.status === "CONFIRMED") {
    await transition(deps, b, "CANCEL_REQUESTED", {}, note);
    const cur = (await deps.store.getBooking(b.id, b.userId))!;
    await transition(deps, cur, "CANCELLED", {}, note);
    return { applied: true };
  }
  return { applied: false, reason: "no-op for current state" };
}
