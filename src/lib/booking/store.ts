import type { Itinerary } from "../domain/types";
import { loadKey } from "../security/crypto";
import { adminClient } from "../supabase/server";
import { BookingError } from "./service";
import { SupabaseStore } from "./supabase-store";
import type { BookingStatus } from "./state";

export interface Quote {
  id: string;
  userId: string;
  providerId: string;
  segmentIds: string[];
  passengers: number;
  totalPerPerson: number; // paise
  totalGroup: number; // paise
  currency: "INR";
  hash: string;
  issuedAt: string;
  expiresAt: string;
  itinerary: Itinerary;
  conditions: string[];
  capability: string;
}

export interface Booking {
  id: string;
  userId: string;
  quoteId: string;
  providerId: string;
  status: BookingStatus;
  idempotencyKey: string;
  externalRef: string | null;
  paymentUrl: string | null;
  totalGroup: number;
  currency: "INR";
  passengerCount: number;
  segmentIds: string[];
  failureReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AuditEvent {
  bookingId: string;
  at: string;
  type: string;
  from?: BookingStatus;
  to?: BookingStatus;
  note?: string; // never contains PII or secrets
}

export type PaymentStatus = "CREATED" | "PENDING" | "COMPLETED" | "FAILED" | "REFUND_REQUIRED" | "REVIEW_REQUIRED";

export interface Payment {
  id: string;
  userId: string;
  bookingId: string;
  gateway: "paypal" | "phonepe";
  amountPaise: number; // what the traveller owes, in INR paise
  chargedMinor: number; // what the gateway charges, in minor units of chargedCurrency
  chargedCurrency: string;
  status: PaymentStatus;
  gatewayOrderId: string | null;
  gatewayTxnId: string | null;
  redirectUrl: string | null;
  note: string | null; // never PII
  createdAt: string;
  updatedAt: string;
}

export interface TempPassengers {
  fullName: string;
  age: number;
}

export interface SavedTrip {
  id: string;
  userId: string;
  title: string;
  constraints: Record<string, unknown>;
  createdAt: string;
}

/**
 * Persistence boundary. Production MUST use a durable implementation (Postgres via Supabase,
 * see supabase/migrations). The in-memory store below is for tests and local development only
 * and is refused when NODE_ENV=production (see getStore()).
 */
export interface Store {
  saveQuote(q: Quote): Promise<void>;
  getQuote(id: string, userId: string): Promise<Quote | null>;
  /** Insert unless (userId, idempotencyKey) exists. Returns existing row when it does. */
  insertBookingIfAbsent(b: Booking): Promise<{ booking: Booking; created: boolean }>;
  getBooking(id: string, userId: string): Promise<Booking | null>;
  getBookingByIdempotency(userId: string, key: string): Promise<Booking | null>;
  getBookingByExternalRef(providerId: string, ref: string): Promise<Booking | null>;
  listBookings(userId: string): Promise<Booking[]>;
  /** Compare-and-set on status to make transitions atomic. */
  updateBooking(id: string, expected: BookingStatus, patch: Partial<Booking>): Promise<Booking | null>;
  addAudit(e: AuditEvent): Promise<void>;
  listAudit(bookingId: string): Promise<AuditEvent[]>;
  /** Webhook replay protection: returns false if this event id was already processed. */
  markProviderEvent(providerId: string, eventId: string): Promise<boolean>;
  // ---- payments
  insertPayment(p: Payment): Promise<void>;
  getPayment(id: string, userId: string): Promise<Payment | null>;
  /** Internal (webhook/settlement) lookup; never expose the result without an ownership check. */
  getPaymentInternal(id: string): Promise<Payment | null>;
  getPaymentByBooking(bookingId: string): Promise<Payment | null>;
  /** Compare-and-set on payment status. */
  updatePayment(id: string, expected: PaymentStatus, patch: Partial<Payment>): Promise<Payment | null>;
  /** Passenger details are held ONLY between checkout and the purchase call, then deleted. */
  holdPassengers(bookingId: string, list: TempPassengers[]): Promise<void>;
  takePassengers(bookingId: string): Promise<TempPassengers[] | null>;
  saveTrip(t: SavedTrip): Promise<void>;
  listTrips(userId: string): Promise<SavedTrip[]>;
  deleteTrip(id: string, userId: string): Promise<boolean>;
  /** Deletes user-owned data; bookings are retained in anonymised form for legal/transaction records. */
  eraseUser(userId: string): Promise<{ deletedTrips: number; retainedBookings: number }>;
  exportUser(userId: string): Promise<{ trips: SavedTrip[]; bookings: Booking[]; quotes: Quote[] }>;
}

export class MemoryStore implements Store {
  quotes = new Map<string, Quote>();
  bookings = new Map<string, Booking>();
  audit: AuditEvent[] = [];
  events = new Set<string>();
  trips = new Map<string, SavedTrip>();
  payments = new Map<string, Payment>();
  held = new Map<string, TempPassengers[]>();

  async insertPayment(p: Payment) {
    this.payments.set(p.id, structuredClone(p));
  }
  async getPayment(id: string, userId: string) {
    const p = this.payments.get(id);
    return p && p.userId === userId ? structuredClone(p) : null;
  }
  async getPaymentInternal(id: string) {
    const p = this.payments.get(id);
    return p ? structuredClone(p) : null;
  }
  async getPaymentByBooking(bookingId: string) {
    const p = [...this.payments.values()].find((x) => x.bookingId === bookingId);
    return p ? structuredClone(p) : null;
  }
  async updatePayment(id: string, expected: PaymentStatus, patch: Partial<Payment>) {
    const p = this.payments.get(id);
    if (!p || p.status !== expected) return null;
    const next = { ...p, ...patch, id: p.id, userId: p.userId, updatedAt: new Date().toISOString() };
    this.payments.set(id, next);
    return structuredClone(next);
  }
  async holdPassengers(bookingId: string, list: TempPassengers[]) {
    this.held.set(bookingId, structuredClone(list));
  }
  async takePassengers(bookingId: string) {
    const l = this.held.get(bookingId) ?? null;
    this.held.delete(bookingId);
    return l;
  }

  async saveQuote(q: Quote) {
    this.quotes.set(q.id, structuredClone(q));
  }
  async getQuote(id: string, userId: string) {
    const q = this.quotes.get(id);
    return q && q.userId === userId ? structuredClone(q) : null; // wrong owner looks identical to missing
  }
  async insertBookingIfAbsent(b: Booking) {
    const existing = [...this.bookings.values()].find((x) => x.userId === b.userId && x.idempotencyKey === b.idempotencyKey);
    if (existing) return { booking: structuredClone(existing), created: false };
    this.bookings.set(b.id, structuredClone(b));
    return { booking: structuredClone(b), created: true };
  }
  async getBooking(id: string, userId: string) {
    const b = this.bookings.get(id);
    return b && b.userId === userId ? structuredClone(b) : null;
  }
  async getBookingByIdempotency(userId: string, key: string) {
    const b = [...this.bookings.values()].find((x) => x.userId === userId && x.idempotencyKey === key);
    return b ? structuredClone(b) : null;
  }
  async getBookingByExternalRef(providerId: string, ref: string) {
    const b = [...this.bookings.values()].find((x) => x.providerId === providerId && x.externalRef === ref);
    return b ? structuredClone(b) : null;
  }
  async listBookings(userId: string) {
    return [...this.bookings.values()].filter((b) => b.userId === userId).map((b) => structuredClone(b));
  }
  async updateBooking(id: string, expected: BookingStatus, patch: Partial<Booking>) {
    const b = this.bookings.get(id);
    if (!b || b.status !== expected) return null;
    const next = { ...b, ...patch, id: b.id, userId: b.userId, updatedAt: new Date().toISOString() };
    this.bookings.set(id, next);
    return structuredClone(next);
  }
  async addAudit(e: AuditEvent) {
    this.audit.push(Object.freeze({ ...e }));
  }
  async listAudit(bookingId: string) {
    return this.audit.filter((a) => a.bookingId === bookingId);
  }
  async markProviderEvent(providerId: string, eventId: string) {
    const k = `${providerId}:${eventId}`;
    if (this.events.has(k)) return false;
    this.events.add(k);
    return true;
  }
  async saveTrip(t: SavedTrip) {
    this.trips.set(t.id, structuredClone(t));
  }
  async listTrips(userId: string) {
    return [...this.trips.values()].filter((t) => t.userId === userId);
  }
  async deleteTrip(id: string, userId: string) {
    const t = this.trips.get(id);
    if (!t || t.userId !== userId) return false;
    this.trips.delete(id);
    return true;
  }
  async eraseUser(userId: string) {
    let deletedTrips = 0;
    for (const [id, t] of this.trips) if (t.userId === userId) { this.trips.delete(id); deletedTrips++; }
    const retained = [...this.bookings.values()].filter((b) => b.userId === userId);
    const keep = new Set(retained.map((b) => b.quoteId)); // quotes a booking points at are part of the financial record
    for (const [id, q] of this.quotes) if (q.userId === userId && !keep.has(id)) this.quotes.delete(id);
    return { deletedTrips, retainedBookings: retained.length };
  }
  async exportUser(userId: string) {
    return {
      trips: await this.listTrips(userId),
      bookings: await this.listBookings(userId),
      quotes: [...this.quotes.values()].filter((q) => q.userId === userId),
    };
  }
}

let singleton: Store | null = null;
export function getStore(): Store {
  if (singleton) return singleton;
  if (process.env.STORE_DRIVER === "supabase") {
    // Durable Postgres via Supabase (service role, server only). Passenger data is encrypted with PASSENGER_DATA_KEY.
    singleton = new SupabaseStore(adminClient(), loadKey());
    return singleton;
  }
  if (process.env.NODE_ENV === "production" && process.env.STORE_DRIVER !== "memory-unsafe") {
    throw new BookingError(
      "STORAGE_NOT_CONFIGURED",
      "Saved trips and bookings are not enabled on this deployment yet (no database configured).",
      503,
    );
  }
  singleton = new MemoryStore();
  return singleton;
}

export function _setStoreForTests(s: Store | null) {
  singleton = s;
}
