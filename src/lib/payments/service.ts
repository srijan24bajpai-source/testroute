import { BookingError, applyResult, checkQuote, createQuote, transition, type ConfirmInput, type Deps } from "../booking/service";
import type { Booking, Payment, Quote } from "../booking/store";
import type { ProviderBookResult } from "../providers/types";
import type { GatewayId, PaymentGateway } from "./types";

export interface PayDeps extends Deps {
  gateway: (id: GatewayId) => PaymentGateway | undefined;
  /** Public https origin used to build return URLs. */
  origin: string;
}

const nowIso = (d: PayDeps) => (d.now ?? (() => new Date()))().toISOString();
const newId = (d: PayDeps) => (d.id ?? (() => crypto.randomUUID()))();

export type CheckoutResult =
  | { kind: "redirect"; payment: Payment; redirectUrl: string; disclosure: string | null }
  | { kind: "existing"; payment: Payment | null; booking: Booking }
  | { kind: "requote"; quote: Quote };

/**
 * Pay-then-book checkout. The amount charged ALWAYS comes from the server-side quote, never from the client.
 * Nothing is purchased here: the provider is called only after the gateway confirms the money (settlePayment).
 */
export async function startCheckout(deps: PayDeps, userId: string, input: ConfirmInput, gatewayId: GatewayId): Promise<CheckoutResult> {
  const gw = deps.gateway(gatewayId);
  if (!gw) throw new BookingError("PAYMENTS_NOT_AVAILABLE", "This payment method is not available right now. No payment has been taken.", 422);

  const prior = await deps.store.getBookingByIdempotency(userId, input.idempotencyKey);
  if (prior) {
    if (prior.quoteId !== input.quoteId) throw new BookingError("IDEMPOTENCY_CONFLICT", "This idempotency key was used for a different quote.", 409);
    return { kind: "existing", booking: prior, payment: await deps.store.getPaymentByBooking(prior.id) };
  }

  const { quote, adapter } = await checkQuote(deps, userId, input); // ownership, expiry, hash, exact amount, consent, capability
  let charge;
  try {
    charge = gw.chargeFor(quote.totalGroup);
  } catch (e) {
    throw new BookingError("PAYMENT_AMOUNT_INVALID", e instanceof Error ? e.message : "This amount cannot be paid with that method.", 422);
  }

  const stamp = nowIso(deps);
  const { booking, created } = await deps.store.insertBookingIfAbsent({
    id: newId(deps), userId, quoteId: quote.id, providerId: quote.providerId, status: "PENDING_USER_CONFIRMATION",
    idempotencyKey: input.idempotencyKey, externalRef: null, paymentUrl: null, totalGroup: quote.totalGroup, currency: "INR",
    passengerCount: quote.passengers, segmentIds: quote.segmentIds, failureReason: null, createdAt: stamp, updatedAt: stamp,
  });
  if (!created) return { kind: "existing", booking, payment: await deps.store.getPaymentByBooking(booking.id) };
  await deps.store.addAudit({ bookingId: booking.id, at: stamp, type: "checkout_started", to: "PENDING_USER_CONFIRMATION", note: gatewayId });

  // Re-price right before taking money.
  const fresh = await adapter.refreshQuote(quote.segmentIds, quote.passengers);
  const freshGroup = fresh.totalPerPerson * quote.passengers + Math.round(quote.itinerary.cost.estimatedPerPerson * quote.passengers);
  if (freshGroup !== quote.totalGroup) {
    const requoted = await createQuote(deps, userId, quote.itinerary);
    await transition(deps, booking, "QUOTE_REFRESH_REQUIRED", {}, "price changed before payment");
    return { kind: "requote", quote: requoted };
  }

  await deps.store.holdPassengers(booking.id, input.passengers); // deleted as soon as the purchase call is made (or on failure)
  const payment: Payment = {
    id: newId(deps), userId, bookingId: booking.id, gateway: gatewayId, amountPaise: quote.totalGroup,
    chargedMinor: charge.minor, chargedCurrency: charge.currency, status: "CREATED",
    gatewayOrderId: null, gatewayTxnId: null, redirectUrl: null, note: null, createdAt: stamp, updatedAt: stamp,
  };
  await deps.store.insertPayment(payment);

  let gwOrder;
  try {
    gwOrder = await gw.create({
      paymentId: payment.id, charge, description: "Travel booking",
      returnUrl: `${deps.origin}/payment/return?pid=${payment.id}`, cancelUrl: `${deps.origin}/payment/return?pid=${payment.id}&cancelled=1`,
    });
  } catch {
    await deps.store.updatePayment(payment.id, "CREATED", { status: "FAILED", note: "gateway create failed" });
    await deps.store.takePassengers(booking.id);
    await transition(deps, booking, "FAILED", { failureReason: "payment could not be started" });
    throw new BookingError("PAYMENT_UNAVAILABLE", "We could not start the payment. Nothing has been charged. Please try again.", 502);
  }

  const pending = (await deps.store.updatePayment(payment.id, "CREATED", { status: "PENDING", gatewayOrderId: gwOrder.gatewayOrderId, redirectUrl: gwOrder.redirectUrl }))!;
  await transition(deps, booking, "PAYMENT_PENDING");
  return { kind: "redirect", payment: pending, redirectUrl: gwOrder.redirectUrl, disclosure: charge.disclosure };
}

/** Called by the status poll and by authenticated webhooks. Idempotent: only one caller can win each transition. */
export async function settlePayment(deps: PayDeps, paymentId: string): Promise<Payment | null> {
  const p = await deps.store.getPaymentInternal(paymentId);
  if (!p) return null;
  if (p.status !== "PENDING") return p;
  const gw = deps.gateway(p.gateway);
  if (!gw || !p.gatewayOrderId) return p;

  let state;
  try {
    state = await gw.reconcile({ paymentId: p.id, gatewayOrderId: p.gatewayOrderId }); // server-to-server: the only source of truth
  } catch {
    return p; // gateway unreachable: stay pending, retried by the next poll/webhook
  }
  if (state.status === "PENDING") return p;

  const booking = await deps.store.getBooking(p.bookingId, p.userId);
  if (state.status === "FAILED") {
    const failed = await deps.store.updatePayment(p.id, "PENDING", { status: "FAILED" });
    if (failed && booking?.status === "PAYMENT_PENDING") {
      await deps.store.takePassengers(booking.id);
      await transition(deps, booking, "FAILED", { failureReason: "payment failed" });
    }
    return failed ?? p;
  }

  // COMPLETED: the amount and currency the gateway reports must equal what we asked for.
  if (state.amountMinor !== p.chargedMinor || state.currency !== p.chargedCurrency) {
    const flagged = await deps.store.updatePayment(p.id, "PENDING", { status: "REVIEW_REQUIRED", gatewayTxnId: state.txnId ?? null, note: "amount or currency mismatch" });
    if (flagged && booking?.status === "PAYMENT_PENDING") {
      await deps.store.takePassengers(booking.id);
      await transition(deps, booking, "FAILED", { failureReason: "payment amount mismatch" });
    }
    return flagged ?? p;
  }
  const won = await deps.store.updatePayment(p.id, "PENDING", { status: "COMPLETED", gatewayTxnId: state.txnId ?? null });
  if (!won) return (await deps.store.getPaymentInternal(p.id)) ?? p; // another caller settled it
  if (booking) await fulfil(deps, won, booking);
  return (await deps.store.getPaymentInternal(p.id)) ?? won;
}

/** Money is in: now make the purchase with the provider. Any failure leaves a clear refund flag. */
async function fulfil(deps: PayDeps, p: Payment, b: Booking): Promise<void> {
  const adapter = deps.getBookingProvider(b.providerId);
  const quote = await deps.store.getQuote(b.quoteId, p.userId);
  const passengers = await deps.store.takePassengers(b.id); // read once, then gone
  if (!adapter || !quote || !passengers || b.status !== "PAYMENT_PENDING") {
    await deps.store.updatePayment(p.id, "COMPLETED", { status: "REFUND_REQUIRED", note: "paid but could not purchase" });
    if (b.status === "PAYMENT_PENDING") await transition(deps, b, "RECONCILIATION_REQUIRED", {}, "paid; purchase not possible");
    return;
  }
  const inProgress = await transition(deps, b, "BOOKING_IN_PROGRESS");
  let result: ProviderBookResult;
  try {
    result = await adapter.book({ segmentIds: quote.segmentIds, passengers, expectedTotal: b.totalGroup, idempotencyKey: b.idempotencyKey });
  } catch {
    result = { outcome: "UNKNOWN" };
  }
  // We already hold the money, so a provider-hosted payment step makes no sense here: treat it as unknown.
  if (result.outcome === "PAYMENT_PENDING") result = { outcome: "UNKNOWN" };
  const done = await applyResult(deps, inProgress, result);
  if (done.status === "FAILED") {
    await deps.store.updatePayment(p.id, "COMPLETED", { status: "REFUND_REQUIRED", note: "purchase declined after payment" });
  }
}

export type WebhookOutcome = { status: 200 | 401 };

export async function handlePaymentWebhook(deps: PayDeps, gatewayId: GatewayId, headers: Headers, rawBody: string): Promise<WebhookOutcome> {
  const gw = deps.gateway(gatewayId);
  if (!gw) return { status: 401 };
  const v = await gw.verifyWebhook(headers, rawBody);
  if (!v.ok) return { status: 401 };
  // The body only tells us WHICH payment to look at; settlePayment asks the gateway for the real state.
  if (v.paymentId) await settlePayment(deps, v.paymentId);
  return { status: 200 };
}

export interface PaymentView {
  id: string;
  status: Payment["status"];
  gateway: Payment["gateway"];
  amountPaise: number;
  chargedMinor: number;
  chargedCurrency: string;
  bookingId: string;
  bookingStatus: Booking["status"] | null;
  bookingReference: string | null;
}

export async function paymentStatus(deps: PayDeps, userId: string, id: string): Promise<PaymentView> {
  let p = await deps.store.getPayment(id, userId); // foreign ids look identical to missing ones
  if (!p) throw new BookingError("NOT_FOUND", "Payment not found.", 404);
  if (p.status === "PENDING") p = (await settlePayment(deps, p.id)) ?? p;
  const b = await deps.store.getBooking(p.bookingId, userId);
  return {
    id: p.id, status: p.status, gateway: p.gateway, amountPaise: p.amountPaise, chargedMinor: p.chargedMinor, chargedCurrency: p.chargedCurrency,
    bookingId: p.bookingId, bookingStatus: b?.status ?? null, bookingReference: b?.status === "CONFIRMED" ? b.externalRef : null,
  };
}
