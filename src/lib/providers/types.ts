import type { Capability, Mode, Segment } from "../domain/types";

export interface SegmentQuery {
  fromCityId: string;
  toCityId: string;
  date: string; // YYYY-MM-DD (IST)
}

/** Adapter contract implemented by every flight/train/bus provider. */
export interface SegmentProvider {
  readonly id: string;
  readonly name: string;
  readonly mode: Mode;
  readonly capability: Capability;
  isConfigured(): boolean;
  searchSegments(q: SegmentQuery, signal: AbortSignal): Promise<Segment[]>;
}

export interface BookingPassenger {
  fullName: string;
  age: number;
}

export interface ProviderQuote {
  segmentIds: string[];
  totalPerPerson: number; // paise
  currency: "INR";
  fareVersion: string;
  expiresAt: string;
}

export type ProviderBookResult =
  | { outcome: "CONFIRMED"; externalRef: string }
  | { outcome: "PAYMENT_PENDING"; paymentUrl: string; externalRef?: string }
  | { outcome: "DECLINED"; reason: string }
  | { outcome: "UNKNOWN" }; // timeout or ambiguous: must be reconciled, never blindly retried

export interface BookingProvider {
  readonly id: string;
  readonly capability: Capability;
  /** Re-price the exact segments with the provider right before checkout. */
  refreshQuote(segmentIds: string[], passengers: number): Promise<ProviderQuote>;
  book(args: {
    segmentIds: string[];
    passengers: BookingPassenger[];
    expectedTotal: number;
    idempotencyKey: string;
  }): Promise<ProviderBookResult>;
  /** Look up an earlier attempt by idempotency key (for reconciliation). */
  lookup(idempotencyKey: string): Promise<ProviderBookResult>;
  cancel?(externalRef: string): Promise<{ outcome: "CANCELLED" | "REFUND_PENDING" | "REJECTED" }>;
}
