import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConstraintsSchema } from "@/lib/domain/types";
import { DuffelFlights, getLiveFlights, type LiveFlightSource } from "@/lib/providers/duffel";
import { getSegmentProviders } from "@/lib/providers/registry";
import { planJourney, resetBreakers } from "@/lib/search/plan";
import { tzOffsetAt, zonedEpoch } from "@/lib/domain/zone";

const NOW = new Date("2026-11-10T06:00:00Z");

const airport = (iata: string, name: string, city: string, tz: string, cc: string) => ({ iata_code: iata, name, city_name: city, time_zone: tz, iata_country_code: cc });
const carrier = { name: "Duffel Airways", iata_code: "ZZ" };
const seg = (o: ReturnType<typeof airport>, d: ReturnType<typeof airport>, dep: string, arr: string, n: string) => ({
  origin: o, destination: d, departing_at: dep, arriving_at: arr, marketing_carrier: carrier, operating_carrier: carrier,
  marketing_carrier_flight_number: n, passengers: [{ cabin_class_marketing_name: "Economy" }],
});
const LKO = airport("LKO", "Chaudhary Charan Singh Intl", "Lucknow", "Asia/Kolkata", "IN");
const DEL = airport("DEL", "Indira Gandhi Intl", "Delhi", "Asia/Kolkata", "IN");
const LHR = airport("LHR", "Heathrow", "London", "Europe/London", "GB");
const GOI = airport("GOI", "Goa Intl", "Goa", "Asia/Kolkata", "IN");

const offerLkoLhr = {
  id: "off_1", total_amount: "400.00", total_currency: "USD", expires_at: "2026-11-10T07:00:00Z", owner: carrier,
  slices: [{ segments: [seg(LKO, DEL, "2026-11-15T06:25:00", "2026-11-15T08:10:00", "101"), seg(DEL, LHR, "2026-11-15T11:00:00", "2026-11-15T15:30:00", "202")] }],
};
const offerLkoGoi = {
  id: "off_2", total_amount: "9000.00", total_currency: "INR", expires_at: "2026-11-10T07:00:00Z", owner: carrier,
  slices: [{ segments: [seg(LKO, GOI, "2026-11-15T09:00:00", "2026-11-15T12:10:00", "303")] }],
};

type Call = { url: string; init: RequestInit };
function mockFetch(body: unknown, status = 200, calls: Call[] = []) {
  const f = vi.fn(async (url: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  });
  return { f: f as unknown as typeof fetch, calls };
}
const q = { originIata: "LKO", destIata: "LHR", date: "2026-11-15", passengers: 2 };

beforeEach(() => resetBreakers());

describe("configuration", () => {
  it("is off without a token and survives bad exchange-rate JSON", () => {
    expect(DuffelFlights.fromEnv({} as NodeJS.ProcessEnv)).toBeNull();
    expect(getLiveFlights({} as NodeJS.ProcessEnv)).toBeNull();
    expect(DuffelFlights.fromEnv({ DUFFEL_ACCESS_TOKEN: "t", DUFFEL_FX_RATES: "not json" } as unknown as NodeJS.ProcessEnv)).not.toBeNull();
  });
  it("has a kill switch", () => {
    expect(getLiveFlights({ DUFFEL_ACCESS_TOKEN: "t", DISABLED_PROVIDERS: "duffel-flights" } as unknown as NodeJS.ProcessEnv)).toBeNull();
  });
});

describe("Duffel search", () => {
  it("sends a correct offer request with the bearer token and API version", async () => {
    const m = mockFetch({ data: { offers: [] } });
    await new DuffelFlights("tok_test", { INR: 1 }, m.f).search(q, NOW);
    const call = m.calls[0];
    expect(call.url).toBe("https://api.duffel.com/air/offer_requests?return_offers=true&supplier_timeout=15000");
    const h = call.init.headers as Record<string, string>;
    expect(h.authorization).toBe("Bearer tok_test");
    expect(h["duffel-version"]).toBe("v2");
    expect(JSON.parse(String(call.init.body))).toEqual({
      data: {
        slices: [{ origin: "LKO", destination: "LHR", departure_date: "2026-11-15" }],
        passengers: [{ type: "adult" }, { type: "adult" }], cabin_class: "economy", max_connections: 2,
      },
    });
  });

  it("maps an offer to a one-ticket itinerary with converted INR price and local times", async () => {
    const m = mockFetch({ data: { offers: [offerLkoLhr] } });
    const [it] = await new DuffelFlights("t", { INR: 1, USD: 85 }, m.f).search(q, NOW);
    expect(it.id).toBe("duffel:off_1");
    expect(it.source).toBe("live");
    expect(it.segments).toHaveLength(2);
    // $400 for 2 passengers at ₹85 = ₹34,000 total = ₹17,000 each; the price sits on the first segment only.
    expect(it.cost.expectedPerPerson).toBe(1_700_000);
    expect(it.cost.expectedGroup).toBe(3_400_000);
    expect(it.segments[0].fare!.amount).toBe(1_700_000);
    expect(it.segments[1].fare!.amount).toBe(0);
    expect(it.cost.confidence).toBe("quoted");
    expect(it.segments.every((s) => s.ticketId === "off_1" && s.capability === "SEARCH_ONLY")).toBe(true);
    // each end shows its own local time; elapsed time is absolute: 06:25 IST -> 15:30 London = 14h35m
    expect(it.segments[0].departAt).toBe("2026-11-15T06:25:00+05:30");
    expect(it.segments[1].arriveAt).toBe("2026-11-15T15:30:00+00:00");
    expect(it.durationMinutes).toBe(14 * 60 + 35);
  });

  it("treats connections inside an offer as protected, not as risky self-transfers", async () => {
    const m = mockFetch({ data: { offers: [offerLkoLhr] } });
    const [it] = await new DuffelFlights("t", { USD: 85 }, m.f).search(q, NOW);
    expect(it.flags.some((f) => f.startsWith("One ticket"))).toBe(true);
    expect(it.flags.some((f) => f.startsWith("Separate tickets") || f.startsWith("Self-transfer"))).toBe(false);
    expect(it.flags.some((f) => /converted at ₹85 per USD/.test(f))).toBe(true);
    expect(it.transfers).toBe(1);
    expect(it.connections[0].waitMinutes).toBe(170);
  });

  it("never guesses a price: skips currencies without a rate and malformed offers", async () => {
    const eur = { ...offerLkoLhr, id: "off_eur", total_currency: "EUR" };
    const broken = { id: "off_bad", total_amount: "x" };
    const m = mockFetch({ data: { offers: [eur, broken, offerLkoGoi] } });
    const out = await new DuffelFlights("t", { INR: 1, USD: 85 }, m.f).search({ ...q, destIata: "GOI", passengers: 1 }, NOW);
    expect(out.map((i) => i.id)).toEqual(["duffel:off_2"]);
    expect(out[0].cost.expectedPerPerson).toBe(900_000);
  });

  it("surfaces API failures instead of returning fake results", async () => {
    const m = mockFetch({ errors: [] }, 401);
    await expect(new DuffelFlights("bad", { INR: 1 }, m.f).search(q, NOW)).rejects.toThrow(/401/);
  });
});

describe("daylight-saving-aware time zones for live data", () => {
  it("uses the real offset on the real date", () => {
    expect(tzOffsetAt("America/New_York", Date.UTC(2026, 6, 1))).toBe(-240); // EDT
    expect(tzOffsetAt("America/New_York", Date.UTC(2026, 0, 15))).toBe(-300); // EST
    expect(tzOffsetAt("Asia/Kolkata", Date.UTC(2026, 6, 1))).toBe(330);
    expect(zonedEpoch("2026-07-01T09:00:00", "America/New_York")).toBe(Date.UTC(2026, 6, 1, 13, 0));
    expect(zonedEpoch("2026-01-15T09:00", "America/New_York")).toBe(Date.UTC(2026, 0, 15, 14, 0));
  });
});

describe("planning with live fares", () => {
  const search = (src: LiveFlightSource | null, o = "Lucknow", d = "Goa", modes: ("flight" | "train" | "bus")[] = ["flight", "train", "bus"]) =>
    planJourney(ConstraintsSchema.parse({ origin: o, destination: d, date: "2026-11-15", modes }), { providers: getSegmentProviders(), liveFlights: src, now: () => NOW });

  it("live fares replace the demo flights; demo trains/buses stay, labelled demo", async () => {
    const m = mockFetch({ data: { offers: [offerLkoGoi] } });
    const r = await search(new DuffelFlights("t", { INR: 1 }, m.f));
    const live = r.itineraries.filter((i) => i.source === "live");
    expect(live).toHaveLength(1);
    expect(r.itineraries.some((i) => i.source !== "live" && i.segments.some((s) => s.mode === "flight"))).toBe(false); // no fictional flights next to real ones
    expect(r.itineraries.some((i) => i.source === "demo")).toBe(true);
    expect(r.dataLabel).toBe("mixed");
    expect(r.notes.some((n) => /Live flight fares from duffel-flights/.test(n))).toBe(true);
    expect(r.providers.some((p) => p.providerId === "duffel-flights" && p.ok)).toBe(true);
    expect(live[0].segments[0].provider).toBe("duffel");
  });

  it("falls back to demo flights when the live service is down, and says so", async () => {
    const m = mockFetch({}, 503);
    const r = await search(new DuffelFlights("t", { INR: 1 }, m.f));
    expect(r.itineraries.some((i) => i.source === "live")).toBe(false);
    expect(r.itineraries.some((i) => i.segments.some((s) => s.mode === "flight"))).toBe(true); // demo flights still shown (labelled demo)
    const st = r.providers.find((p) => p.providerId === "duffel-flights")!;
    expect(st.ok).toBe(false);
    expect(r.partial).toBe(true);
    expect(JSON.stringify(r)).not.toMatch(/503|Bearer/); // no provider internals leak
  });

  it("is not called when flights are excluded", async () => {
    const m = mockFetch({ data: { offers: [offerLkoGoi] } });
    await search(new DuffelFlights("t", { INR: 1 }, m.f), "Lucknow", "Goa", ["train"]);
    expect(m.calls).toHaveLength(0);
  });

  it("works without any live source (pure demo)", async () => {
    const r = await search(null);
    expect(r.itineraries.every((i) => i.source === "demo")).toBe(true);
  });
});
