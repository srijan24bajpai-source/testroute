export type BookingStatus =
  | "DRAFT"
  | "QUOTE_REFRESH_REQUIRED"
  | "PENDING_USER_CONFIRMATION"
  | "BOOKING_IN_PROGRESS"
  | "PAYMENT_PENDING"
  | "RECONCILIATION_REQUIRED"
  | "CONFIRMED"
  | "FAILED"
  | "CANCEL_REQUESTED"
  | "CANCELLED"
  | "REFUND_PENDING";

const TRANSITIONS: Record<BookingStatus, BookingStatus[]> = {
  DRAFT: ["QUOTE_REFRESH_REQUIRED", "PENDING_USER_CONFIRMATION", "FAILED"],
  QUOTE_REFRESH_REQUIRED: ["PENDING_USER_CONFIRMATION", "FAILED"],
  PENDING_USER_CONFIRMATION: ["BOOKING_IN_PROGRESS", "PAYMENT_PENDING", "QUOTE_REFRESH_REQUIRED", "FAILED"],
  BOOKING_IN_PROGRESS: ["CONFIRMED", "PAYMENT_PENDING", "RECONCILIATION_REQUIRED", "FAILED"],
  PAYMENT_PENDING: ["BOOKING_IN_PROGRESS", "CONFIRMED", "FAILED", "RECONCILIATION_REQUIRED"],
  RECONCILIATION_REQUIRED: ["CONFIRMED", "PAYMENT_PENDING", "FAILED"],
  CONFIRMED: ["CANCEL_REQUESTED"],
  FAILED: [],
  CANCEL_REQUESTED: ["CANCELLED", "REFUND_PENDING", "CONFIRMED"], // CONFIRMED = provider rejected cancel
  CANCELLED: [],
  REFUND_PENDING: ["CANCELLED"],
};

export class IllegalTransition extends Error {
  constructor(public from: BookingStatus, public to: BookingStatus) {
    super(`Illegal booking transition ${from} → ${to}`);
  }
}

export function canTransition(from: BookingStatus, to: BookingStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: BookingStatus, to: BookingStatus): void {
  if (!canTransition(from, to)) throw new IllegalTransition(from, to);
}

/** A booking is only ever shown as confirmed when it has a provider-issued reference. */
export function isTrulyConfirmed(b: { status: BookingStatus; externalRef: string | null }): boolean {
  return b.status === "CONFIRMED" && !!b.externalRef;
}
