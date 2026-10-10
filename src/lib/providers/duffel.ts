import { z } from "zod";
import type { Connection, Itinerary, Segment, Terminal } from "../domain/types";
import { inr } from "../domain/money";
import { minutesBetween, overlapsNight, toIsoOffset } from "../domain/time";
import { tzOffsetAt, zonedEpoch } from "../domain/zone";
import { countryName } from "../geo/data";
import { assemble } from "../search/routes";

/**
 * LIVE flight fares via the Duffel Flights API (https://duffel.com/docs/api). Written from Duffel's published docs:
 * POST /air/offer_requests?return_offers=true -> offers with total_amount/total_currency, slices, segments.
 * Mapped to our model as ONE ticket per offer (connections inside an offer are protected by the airline).
 *
 * NOT yet exercised against the real API (needs the owner's DUFFEL_ACCESS_TOKEN). Searching is read-only.
 * In-app booking through Duffel is NOT implemented: results link out to a fare search.
 *
 * Duffel prices in the airline's currency. We convert to INR with rates YOU provide in DUFFEL_FX_RATES
 * (e.g. {"USD":85,"EUR":92,"GBP":108}); offers in a currency without a rate are skipped, never guessed.
 */
const BASE = "https://api.duffel.com";

const Airport = z.object({ iata_code: z.string(), name: z.string(), city_name: z.string().nullish(), time_zone: z.string(), iata_country_code: z.string().nullish() }).passthrough();
const Carrier = z.object({ name: z.string(), iata_code: z.string().nullish() }).passthrough();
const Seg = z.object({
  origin: Airport, destination: Airport, departing_at: z.string(), arriving_at: z.string(),
  marketing_carrier: Carrier, operating_carrier: Carrier.nullish(), marketing_carrier_flight_number: z.string().nullish(),
  passengers: z.array(z.object({ cabin_class_marketing_name: z.string().nullish() }).passthrough()).nullish(),
}).passthrough();
const Offer = z.object({
  id: z.string(), total_amount: z.string(), total_currency: z.string(), expires_at: z.string().nullish(),
  owner: Carrier.nullish(), slices: z.array(z.object({ segments: z.array(Seg).min(1) }).passthrough()).min(1),
}).passthrough();
const Response = z.object({ data: z.object({ offers: z.array(z.unknown()).default([]) }).passthrough() });

export interface LiveQuery {
  originIata: string;
  destIata: string;
  date: string; // local date at origin, YYYY-MM-DD
  passengers: number;
  cabin?: "economy" | "premium_economy" | "business" | "first";
  maxConnections?: number;
}

export interface LiveFlightSource {
  readonly id: string;
  search(q: LiveQuery, now: Date, signal?: AbortSignal): Promise<Itinerary[]>;
}

export class DuffelFlights implements LiveFlightSource {
  readonly id = "duffel-flights";
  constructor(private token: string, private fx: Record<string, number>, private f: typeof fetch = fetch) {}

  static fromEnv(env: NodeJS.ProcessEnv = process.env, f?: typeof fetch): DuffelFlights | null {
    if (!env.DUFFEL_ACCESS_TOKEN) return null;
    let fx: Record<string, number> = { INR: 1 };
    try {
      const parsed = z.record(z.string(), z.number().positive()).safeParse(JSON.parse(env.DUFFEL_FX_RATES ?? "{}"));
      if (parsed.success) fx = { INR: 1, ...parsed.data };
    } catch {
      /* invalid JSON: only INR offers will be used */
    }
    return new DuffelFlights(env.DUFFEL_ACCESS_TOKEN, fx, f);
  }

  async search(q: LiveQuery, now: Date, signal?: AbortSignal): Promise<Itinerary[]> {
    const res = await this.f(`${BASE}/air/offer_requests?return_offers=true&supplier_timeout=15000`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.token}`, "duffel-version": "v2", "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        data: {
          slices: [{ origin: q.originIata, destination: q.destIata, departure_date: q.date }],
          passengers: Array.from({ length: q.passengers }, () => ({ type: "adult" })),
          cabin_class: q.cabin ?? "economy",
          max_connections: q.maxConnections ?? 2,
        },
      }),
      signal: signal ?? AbortSignal.timeout(25_000),
    });
    if (!res.ok) throw new Error(`Duffel search failed (${res.status})`);
    const body = Response.parse(await res.json());
    const out: Itinerary[] = [];
    for (const raw of body.data.offers) {
      const offer = Offer.safeParse(raw);
      if (!offer.success) continue; // unknown shape: skip rather than guess
      const it = this.toItinerary(offer.data, q.passengers, now);
      if (it) out.push(it);
    }
    return out;
  }

  private terminal(a: z.infer<typeof Airport>, atEpoch: number): Terminal {
    return {
      code: a.iata_code, name: `${a.name} (${a.iata_code})`, cityId: `ap-${a.iata_code.toLowerCase()}`, cityName: a.city_name ?? a.name,
      country: a.iata_country_code ? countryName(a.iata_country_code) : "", kind: "airport", utcOffsetMin: tzOffsetAt(a.time_zone, atEpoch),
    };
  }

  private toItinerary(o: z.infer<typeof Offer>, passengers: number, now: Date): Itinerary | null {
    const rate = this.fx[o.total_currency];
    const total = Number(o.total_amount);
    if (!rate || !Number.isFinite(total) || total <= 0) return null; // no FX rate -> never guess a price
    const perPersonPaise = Math.round(((total * rate) / passengers) * 100);
    const slice = o.slices[0];

    const segments: Segment[] = slice.segments.map((s, i) => {
      const dep = zonedEpoch(s.departing_at, s.origin.time_zone);
      const arr = zonedEpoch(s.arriving_at, s.destination.time_zone);
      const from = this.terminal(s.origin, dep);
      const to = this.terminal(s.destination, arr);
      const flight = `${s.marketing_carrier.iata_code ?? ""}${s.marketing_carrier_flight_number ?? ""}`;
      return {
        id: `D-${o.id}-${i}`, serviceId: flight || `D-${o.id}-${i}`, mode: "flight", operator: s.marketing_carrier.name, provider: "duffel",
        from, to, departAt: toIsoOffset(dep, from.utcOffsetMin), arriveAt: toIsoOffset(arr, to.utcOffsetMin),
        // The whole ticket price sits on the first segment; the rest are covered by the same ticket.
        fare: i === 0 ? { amount: perPersonPaise, currency: "INR" } : { amount: 0, currency: "INR" },
        fareKind: "quoted", fareClass: s.passengers?.[0]?.cabin_class_marketing_name ?? "Economy", source: "live", fetchedAt: now.toISOString(),
        capability: "SEARCH_ONLY", refundable: null, ticketId: o.id,
      };
    });

    const connections: Connection[] = segments.slice(1).map((s, i) => {
      const prev = segments[i];
      const arriveMs = Date.parse(prev.arriveAt);
      const departMs = Date.parse(s.departAt);
      return {
        fromSegmentId: prev.id, toSegmentId: s.id, waitMinutes: minutesBetween(arriveMs, departMs),
        terminalChange: prev.to.code !== s.from.code, overnight: overlapsNight(arriveMs, departMs, prev.to.utcOffsetMin),
      };
    });
    const it = assemble(segments, connections, passengers, { now });
    it.id = `duffel:${o.id}`;
    if (o.expires_at) it.flags.push(`Fare held by the airline until ${o.expires_at.slice(0, 16).replace("T", " ")} UTC; re-check before paying.`);
    it.flags.push(`Priced in ${o.total_currency}, converted at ₹${this.fx[o.total_currency]} per ${o.total_currency}; the airline's final price may differ slightly.`);
    return it;
  }
}

export function getLiveFlights(env: NodeJS.ProcessEnv = process.env): LiveFlightSource | null {
  if ((env.DISABLED_PROVIDERS ?? "").split(",").map((s) => s.trim()).includes("duffel-flights")) return null;
  return DuffelFlights.fromEnv(env);
}
