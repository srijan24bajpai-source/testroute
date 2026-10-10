// SERVER-ONLY. Durable Store backed by Supabase Postgres (service-role client). Tables: supabase/migrations/0001_init.sql and 0002_payments.sql.
// Written against the PostgREST client API and unit-tested with an in-memory emulator; NOT yet run against a live Supabase project.
import type { SupabaseClient } from "@supabase/supabase-js";
import { decrypt, encrypt } from "../security/crypto";
import type { Itinerary } from "../domain/types";
import type { BookingStatus } from "./state";
import type { AuditEvent, Booking, Payment, PaymentStatus, Quote, SavedTrip, Store, TempPassengers } from "./store";

type Row = Record<string, unknown>;

const UNIQUE_VIOLATION = "23505";

function must<T>(res: { data: T | null; error: { message: string; code?: string } | null }, what: string): T {
  if (res.error) throw new Error(`${what}: ${res.error.message}`);
  return res.data as T;
}

// ---- row <-> object mapping --------------------------------------------------------------
const quoteToRow = (q: Quote): Row => ({
  id: q.id, user_id: q.userId, provider_id: q.providerId, segment_ids: q.segmentIds, passengers: q.passengers,
  total_group_paise: q.totalGroup, currency: q.currency, hash: q.hash, issued_at: q.issuedAt, expires_at: q.expiresAt,
  capability: q.capability, snapshot: { itinerary: q.itinerary, conditions: q.conditions, totalPerPerson: q.totalPerPerson },
});
const rowToQuote = (r: Row): Quote => {
  const snap = r.snapshot as { itinerary: Itinerary; conditions: string[]; totalPerPerson: number };
  return {
    id: r.id as string, userId: r.user_id as string, providerId: r.provider_id as string, segmentIds: r.segment_ids as string[],
    passengers: r.passengers as number, totalPerPerson: snap.totalPerPerson, totalGroup: Number(r.total_group_paise), currency: "INR",
    hash: r.hash as string, issuedAt: r.issued_at as string, expiresAt: r.expires_at as string, itinerary: snap.itinerary,
    conditions: snap.conditions, capability: r.capability as string,
  };
};

const bookingToRow = (b: Booking): Row => ({
  id: b.id, user_id: b.userId, quote_id: b.quoteId, provider_id: b.providerId, status: b.status, idempotency_key: b.idempotencyKey,
  external_ref: b.externalRef, payment_url: b.paymentUrl, total_group_paise: b.totalGroup, currency: b.currency,
  passenger_count: b.passengerCount, segment_ids: b.segmentIds, failure_reason: b.failureReason, created_at: b.createdAt, updated_at: b.updatedAt,
});
const rowToBooking = (r: Row): Booking => ({
  id: r.id as string, userId: r.user_id as string, quoteId: r.quote_id as string, providerId: r.provider_id as string,
  status: r.status as BookingStatus, idempotencyKey: r.idempotency_key as string, externalRef: (r.external_ref as string) ?? null,
  paymentUrl: (r.payment_url as string) ?? null, totalGroup: Number(r.total_group_paise), currency: "INR",
  passengerCount: r.passenger_count as number, segmentIds: (r.segment_ids as string[]) ?? [], failureReason: (r.failure_reason as string) ?? null,
  createdAt: r.created_at as string, updatedAt: r.updated_at as string,
});
const bookingPatchToRow = (p: Partial<Booking>): Row => {
  const m: Record<string, string> = {
    status: "status", externalRef: "external_ref", paymentUrl: "payment_url", failureReason: "failure_reason", totalGroup: "total_group_paise",
    segmentIds: "segment_ids", providerId: "provider_id",
  };
  const out: Row = { updated_at: new Date().toISOString() };
  for (const [k, v] of Object.entries(p)) if (m[k]) out[m[k]] = v;
  return out;
};

const paymentToRow = (p: Payment): Row => ({
  id: p.id, user_id: p.userId, booking_id: p.bookingId, gateway: p.gateway, amount_paise: p.amountPaise, charged_minor: p.chargedMinor,
  charged_currency: p.chargedCurrency, status: p.status, gateway_order_id: p.gatewayOrderId, gateway_txn_id: p.gatewayTxnId,
  redirect_url: p.redirectUrl, note: p.note, created_at: p.createdAt, updated_at: p.updatedAt,
});
const rowToPayment = (r: Row): Payment => ({
  id: r.id as string, userId: r.user_id as string, bookingId: r.booking_id as string, gateway: r.gateway as Payment["gateway"],
  amountPaise: Number(r.amount_paise), chargedMinor: Number(r.charged_minor), chargedCurrency: r.charged_currency as string,
  status: r.status as PaymentStatus, gatewayOrderId: (r.gateway_order_id as string) ?? null, gatewayTxnId: (r.gateway_txn_id as string) ?? null,
  redirectUrl: (r.redirect_url as string) ?? null, note: (r.note as string) ?? null, createdAt: r.created_at as string, updatedAt: r.updated_at as string,
});
const paymentPatchToRow = (p: Partial<Payment>): Row => {
  const m: Record<string, string> = { status: "status", gatewayOrderId: "gateway_order_id", gatewayTxnId: "gateway_txn_id", redirectUrl: "redirect_url", note: "note" };
  const out: Row = { updated_at: new Date().toISOString() };
  for (const [k, v] of Object.entries(p)) if (m[k]) out[m[k]] = v;
  return out;
};

const tripToRow = (t: SavedTrip): Row => ({ id: t.id, user_id: t.userId, title: t.title, constraints: t.constraints, created_at: t.createdAt });
const rowToTrip = (r: Row): SavedTrip => ({ id: r.id as string, userId: r.user_id as string, title: r.title as string, constraints: r.constraints as Record<string, unknown>, createdAt: r.created_at as string });

// PostgREST returns/accepts bytea as a hex string: "\\x<hex>".
const toBytea = (b: Buffer) => `\\x${b.toString("hex")}`;
const fromBytea = (s: string) => Buffer.from(s.startsWith("\\x") ? s.slice(2) : s, "hex");

export class SupabaseStore implements Store {
  constructor(private db: SupabaseClient, private key: Buffer) {}

  async saveQuote(q: Quote) {
    must(await this.db.from("quotes").upsert(quoteToRow(q)), "saveQuote");
  }
  async getQuote(id: string, userId: string) {
    const r = must(await this.db.from("quotes").select("*").eq("id", id).eq("user_id", userId).maybeSingle(), "getQuote");
    return r ? rowToQuote(r as Row) : null;
  }

  async insertBookingIfAbsent(b: Booking) {
    const res = await this.db.from("bookings").insert(bookingToRow(b)).select("*").maybeSingle();
    if (res.error) {
      if (res.error.code === UNIQUE_VIOLATION) {
        const existing = await this.getBookingByIdempotency(b.userId, b.idempotencyKey);
        if (existing) return { booking: existing, created: false };
      }
      throw new Error(`insertBooking: ${res.error.message}`);
    }
    return { booking: rowToBooking(res.data as Row), created: true };
  }
  async getBooking(id: string, userId: string) {
    const r = must(await this.db.from("bookings").select("*").eq("id", id).eq("user_id", userId).maybeSingle(), "getBooking");
    return r ? rowToBooking(r as Row) : null;
  }
  async getBookingByIdempotency(userId: string, key: string) {
    const r = must(await this.db.from("bookings").select("*").eq("user_id", userId).eq("idempotency_key", key).maybeSingle(), "getBookingByIdempotency");
    return r ? rowToBooking(r as Row) : null;
  }
  async getBookingByExternalRef(providerId: string, ref: string) {
    const r = must(await this.db.from("bookings").select("*").eq("provider_id", providerId).eq("external_ref", ref).maybeSingle(), "getBookingByExternalRef");
    return r ? rowToBooking(r as Row) : null;
  }
  async listBookings(userId: string) {
    const rows = must(await this.db.from("bookings").select("*").eq("user_id", userId).order("created_at", { ascending: false }), "listBookings");
    return (rows as Row[]).map(rowToBooking);
  }
  async updateBooking(id: string, expected: BookingStatus, patch: Partial<Booking>) {
    // Compare-and-set: the status filter makes this atomic in Postgres; no row back means someone else moved it.
    const r = must(await this.db.from("bookings").update(bookingPatchToRow(patch)).eq("id", id).eq("status", expected).select("*").maybeSingle(), "updateBooking");
    return r ? rowToBooking(r as Row) : null;
  }

  async addAudit(e: AuditEvent) {
    must(await this.db.from("booking_audit_events").insert({ booking_id: e.bookingId, at: e.at, type: e.type, from_status: e.from ?? null, to_status: e.to ?? null, note: e.note?.slice(0, 200) ?? null }), "addAudit");
  }
  async listAudit(bookingId: string) {
    const rows = must(await this.db.from("booking_audit_events").select("*").eq("booking_id", bookingId).order("id", { ascending: true }), "listAudit");
    return (rows as Row[]).map((r) => ({ bookingId: r.booking_id as string, at: r.at as string, type: r.type as string, from: (r.from_status as BookingStatus) ?? undefined, to: (r.to_status as BookingStatus) ?? undefined, note: (r.note as string) ?? undefined }));
  }

  async markProviderEvent(providerId: string, eventId: string) {
    const res = await this.db.from("provider_events").insert({ provider_id: providerId, event_id: eventId });
    if (res.error) {
      if (res.error.code === UNIQUE_VIOLATION) return false; // replay
      throw new Error(`markProviderEvent: ${res.error.message}`);
    }
    return true;
  }

  // ---- payments
  async insertPayment(p: Payment) {
    must(await this.db.from("payments").insert(paymentToRow(p)), "insertPayment");
  }
  async getPayment(id: string, userId: string) {
    const r = must(await this.db.from("payments").select("*").eq("id", id).eq("user_id", userId).maybeSingle(), "getPayment");
    return r ? rowToPayment(r as Row) : null;
  }
  async getPaymentInternal(id: string) {
    const r = must(await this.db.from("payments").select("*").eq("id", id).maybeSingle(), "getPaymentInternal");
    return r ? rowToPayment(r as Row) : null;
  }
  async getPaymentByBooking(bookingId: string) {
    const r = must(await this.db.from("payments").select("*").eq("booking_id", bookingId).maybeSingle(), "getPaymentByBooking");
    return r ? rowToPayment(r as Row) : null;
  }
  async updatePayment(id: string, expected: PaymentStatus, patch: Partial<Payment>) {
    const r = must(await this.db.from("payments").update(paymentPatchToRow(patch)).eq("id", id).eq("status", expected).select("*").maybeSingle(), "updatePayment");
    return r ? rowToPayment(r as Row) : null;
  }

  // ---- temporary passenger details (encrypted at rest, deleted after use)
  async holdPassengers(bookingId: string, list: TempPassengers[]) {
    const blob = encrypt(JSON.stringify(list), this.key);
    must(await this.db.from("booking_passengers_tmp").upsert({ booking_id: bookingId, payload_encrypted: toBytea(blob), expires_at: new Date(Date.now() + 2 * 3600_000).toISOString() }), "holdPassengers");
  }
  async takePassengers(bookingId: string) {
    // delete ... returning: whoever deletes the row owns the data, so it can be used exactly once.
    const row = must(await this.db.from("booking_passengers_tmp").delete().eq("booking_id", bookingId).select("*").maybeSingle(), "takePassengers") as Row | null;
    if (!row) return null;
    if (new Date(row.expires_at as string).getTime() < Date.now()) return null; // expired: treat as gone
    try {
      return JSON.parse(decrypt(fromBytea(row.payload_encrypted as string), this.key)) as TempPassengers[];
    } catch {
      return null; // tampered or wrong key: never act on it
    }
  }

  // ---- trips and lifecycle
  async saveTrip(t: SavedTrip) {
    must(await this.db.from("trips").insert(tripToRow(t)), "saveTrip");
  }
  async listTrips(userId: string) {
    const rows = must(await this.db.from("trips").select("*").eq("user_id", userId).order("created_at", { ascending: false }), "listTrips");
    return (rows as Row[]).map(rowToTrip);
  }
  async deleteTrip(id: string, userId: string) {
    const rows = must(await this.db.from("trips").delete().eq("id", id).eq("user_id", userId).select("id"), "deleteTrip");
    return (rows as Row[]).length > 0;
  }
  async eraseUser(userId: string) {
    const trips = must(await this.db.from("trips").delete().eq("user_id", userId).select("id"), "eraseUser.trips") as Row[];
    must(await this.db.from("saved_searches").delete().eq("user_id", userId), "eraseUser.searches");
    // Quotes referenced by bookings are kept (financial record); the rest are deleted.
    const bookings = must(await this.db.from("bookings").select("id, quote_id").eq("user_id", userId), "eraseUser.bookings") as Row[];
    const keep = bookings.map((b) => b.quote_id as string);
    const quotes = must(await this.db.from("quotes").select("id").eq("user_id", userId), "eraseUser.quotes") as Row[];
    const drop = quotes.map((q) => q.id as string).filter((id) => !keep.includes(id));
    if (drop.length) must(await this.db.from("quotes").delete().in("id", drop), "eraseUser.deleteQuotes");
    return { deletedTrips: trips.length, retainedBookings: bookings.length };
  }
  async exportUser(userId: string) {
    return { trips: await this.listTrips(userId), bookings: await this.listBookings(userId), quotes: await this.listQuotes(userId) };
  }
  private async listQuotes(userId: string) {
    const rows = must(await this.db.from("quotes").select("*").eq("user_id", userId), "listQuotes");
    return (rows as Row[]).map(rowToQuote);
  }
}
