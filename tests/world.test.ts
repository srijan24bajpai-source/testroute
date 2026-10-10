import { beforeEach, describe, expect, it } from "vitest";
import { ConstraintsSchema, type Constraints } from "@/lib/domain/types";
import { directoryStats, resolvePlaceStrict, searchPlaces } from "@/lib/geo/directory";
import { locate } from "@/lib/geo/locate";
import { charterOptions } from "@/lib/geo/charter";
import { planJourney, resetBreakers, PlaceError } from "@/lib/search/plan";
import { getSegmentProviders } from "@/lib/providers/registry";
import { extractIntent } from "@/lib/agent/intent";
import { CITIES } from "@/lib/domain/places";
import { parseTime } from "@/lib/domain/time";
import { _resetRateLimits } from "@/lib/security/rate-limit";

const NOW = new Date("2026-11-10T06:00:00Z");
const search = (o: Partial<Constraints>) =>
  planJourney(ConstraintsSchema.parse({ date: "2026-11-15", ...o }), { providers: getSegmentProviders(), now: () => NOW });

beforeEach(() => resetBreakers());

describe("the directory covers the world", () => {
  it("has tens of thousands of places across every continent", () => {
    const s = directoryStats();
    expect(s.cities).toBeGreaterThan(30_000);
    expect(s.states).toBeGreaterThan(2_500);
    expect(s.airports).toBeGreaterThan(8_000);
    expect(s.countries).toBeGreaterThan(240);
    expect(CITIES.length).toBeGreaterThan(3_500); // every scheduled airport is a route node
  });

  it("finds places on every continent by name, state and code", () => {
    for (const [q, expected] of [
      ["Kanpur", "Kanpur"], ["Ulaanbaatar", "Ulaanbaatar"], ["Punta Arenas", "Punta Arenas"], ["Reykjavik", "Reykjav"],
      ["Timbuktu", "Timbuktu"], ["Nairobi", "Nairobi"], ["Honolulu", "Honolulu"], ["Kyiv", "Kyiv"], ["Hobart", "Hobart"],
    ]) {
      expect(searchPlaces(q, 3).some((p) => p.label.includes(expected)), q).toBe(true);
    }
  });

  it("includes states and provinces, not just cities", () => {
    const labels = searchPlaces("Rajasthan", 3).map((p) => p.label);
    expect(labels[0]).toBe("Rajasthan (state/region), India");
    expect(searchPlaces("Bavaria", 3)[0].kind).toBe("state");
    expect(searchPlaces("Queensland", 3)[0].kind).toBe("state");
  });

  it("disambiguates the same name in different places", () => {
    const goa = searchPlaces("Goa", 8).map((p) => p.label);
    expect(goa).toContain("Goa (state/region), India");
    expect(goa.some((l) => l.includes("Philippines"))).toBe(true);
    expect(searchPlaces("Springfield", 8).length).toBeGreaterThan(1);
    expect(searchPlaces("Portland, Maine", 3)[0].label).toMatch(/Maine/);
    expect(searchPlaces("Portland, Oregon", 3)[0].label).toMatch(/Oregon/);
  });

  it("finds airports by code and by name, including heliport/seaplane-coded ones in the data", () => {
    expect(searchPlaces("LHR", 2)[0].label).toMatch(/Heathrow/);
    expect(searchPlaces("Heathrow", 3).some((p) => p.iata === "LHR")).toBe(true);
  });

  it("is typo tolerant and accent-insensitive", () => {
    expect(resolvePlaceStrict("Reykjavík")?.name).toMatch(/Reykjav/);
    expect(resolvePlaceStrict("Lucknw")?.name).toBe("Lucknow");
    expect(resolvePlaceStrict("sao paulo")?.country).toBe("Brazil");
  });

  it("strict mode never accepts a bare prefix (stray words are not cities)", () => {
    expect(resolvePlaceStrict("sh")).toBeNull();
    expect(resolvePlaceStrict("fastest")).toBeNull();
  });

  it("round-trips the labels it produces", () => {
    for (const q of ["Kanpur", "Goa", "Rajasthan", "Portland, Maine", "LHR"]) {
      const p = searchPlaces(q, 1)[0];
      const again = locate(p.label);
      expect(again, p.label).not.toBeNull();
      expect(again!.place?.id ?? again!.node.id).toBeTruthy();
    }
    expect(locate("Rajasthan (state/region), India")!.place?.kind).toBe("state");
    expect(locate(searchPlaces("LHR", 1)[0].label)!.node.iata).toBe("LHR");
  });
});

describe("mapping any place onto the route network", () => {
  it("places near an airport map straight onto it", () => {
    const k = locate("Kanpur")!;
    expect(k.node.iata).toBe("KNU");
    expect(k.roadKm).toBe(0);
  });
  it("remote places get an estimated road leg", () => {
    const r = locate("Fairbanks, Alaska")!;
    expect(r.node.iata).toBe("FAI");
    const farm = locate("Shimla")!; // hill town, airport ~20 km away
    expect(farm.node).toBeTruthy();
  });
  it("places beyond 700 km of any scheduled airport are refused, not guessed", () => {
    expect(locate("Nonexistentville")).toBeNull();
  });
  it("prefers curated hubs for the places that have them", () => {
    expect(locate("Mumbai")!.node.id).toBe("mumbai");
    expect(locate("Delhi")!.node.id).toBe("delhi");
  });
});

describe("search works between any two places", () => {
  const cases: [string, string][] = [
    ["Kanpur", "Pune"], ["Rajasthan", "Kerala"], ["Reykjavik", "Sydney"], ["Ulaanbaatar", "Cape Town"],
    ["Fairbanks, Alaska", "Punta Arenas"], ["Oaxaca, Mexico", "Kyoto"], ["Timbuktu", "Lima"],
  ];
  it.each(cases)("%s → %s returns demo itineraries", async (o, d) => {
    const r = await search({ origin: o, destination: d });
    expect(r.itineraries.length, `${o} -> ${d}`).toBeGreaterThan(0);
    expect(r.dataLabel).toBe("demo");
    expect(r.rankings.fastest.length).toBeGreaterThan(0);
    for (const it of r.itineraries) {
      for (let i = 1; i < it.segments.length; i++) {
        expect(parseTime(it.segments[i].departAt), "no time travel").toBeGreaterThanOrEqual(parseTime(it.segments[i - 1].arriveAt) - 1);
      }
    }
  }, 30_000);

  it("includes the first/last-mile road leg in time, cost and flags", async () => {
    const r = await search({ origin: "Kyoto", destination: "Reykjavik" });
    const it = r.itineraries.find((i) => i.segments.some((s) => s.provider === "road-estimate"))!;
    expect(it).toBeTruthy();
    const road = it.segments.filter((s) => s.provider === "road-estimate");
    expect(road.every((s) => s.fareKind === "estimated" && s.fareLow && s.fareHigh)).toBe(true);
    expect(it.cost.estimatedPerPerson).toBeGreaterThan(0);
    expect(it.flags.some((f) => /road transfer/i.test(f))).toBe(true);
    const total = (parseTime(it.arriveAt) - parseTime(it.departAt)) / 60_000;
    expect(it.durationMinutes).toBe(total);
  }, 30_000);

  it("applies budget and deadline to the FINAL itinerary, road legs included", async () => {
    const all = await search({ origin: "Kyoto", destination: "Reykjavik" });
    const cheapest = Math.min(...all.itineraries.map((i) => i.cost.expectedPerPerson));
    const tight = await search({ origin: "Kyoto", destination: "Reykjavik", maxBudgetPerPerson: Math.floor(cheapest / 100) - 1 });
    expect(tight.itineraries.length).toBe(0);
  }, 30_000);

  it("explains unknown places with suggestions across the whole directory", async () => {
    await expect(search({ origin: "Kanpurr", destination: "Pune" })).resolves.toBeTruthy(); // one typo is fine
    const err = await search({ origin: "Qzxwv", destination: "Pune" }).catch((e) => e);
    expect(err).toBeInstanceOf(PlaceError);
    expect(String(err.message)).toMatch(/couldn't find/i);
  });

  it("two places served by the same hub give a clear message", async () => {
    const err = await search({ origin: "Noida", destination: "Delhi" }).catch((e) => e);
    expect(err).toBeInstanceOf(PlaceError);
    expect(String(err.message)).toMatch(/by road|must differ/i);
  });

  it("stays reasonably fast", async () => {
    const t0 = Date.now();
    await search({ origin: "Rajasthan", destination: "Kerala" });
    expect(Date.now() - t0).toBeLessThan(10_000);
  }, 30_000);
});

describe("charter-style options (never priced)", () => {
  it("offers private jets between airports, helicopters only for short hops", () => {
    const delMum = charterOptions(locate("Delhi")!, locate("Mumbai")!);
    expect(delMum.some((c) => c.mode === "private_jet")).toBe(true);
    expect(delMum.some((c) => c.mode === "helicopter")).toBe(false); // ~1,150 km: out of helicopter range
    const short = charterOptions(locate("Mumbai")!, locate("Pune")!);
    expect(short.some((c) => c.mode === "helicopter")).toBe(true);
  });
  it("never includes a fare and always links to a search for operators", () => {
    for (const c of charterOptions(locate("Mumbai")!, locate("Pune")!)) {
      expect(JSON.stringify(c)).not.toMatch(/fare|price":|amount/i);
      expect(c.link.url.startsWith("https://")).toBe(true);
    }
  });
  it("is attached to search results", async () => {
    const r = await search({ origin: "Lucknow", destination: "Goa" });
    expect(Array.isArray(r.charter)).toBe(true);
    expect(r.charter!.some((c) => c.mode === "private_jet")).toBe(true);
  }, 30_000);
});

describe("chat understands any place", () => {
  it("parses far-flung places and states", () => {
    expect(extractIntent("Kanpur to Pune tomorrow", NOW).patch).toMatchObject({ origin: expect.stringContaining("Kanpur"), destination: "Pune" });
    const r = extractIntent("from Reykjavik to Sydney for 2", NOW).patch;
    expect(r.origin).toMatch(/Reykjav/);
    expect(r.destination).toBe("Sydney");
    expect(extractIntent("from Rajasthan to Kerala", NOW).patch.origin).toMatch(/Rajasthan/);
  });
  it("keeps curated short names and still ignores filler words", () => {
    expect(extractIntent("show me travel from lko to goa", NOW).patch).toMatchObject({ origin: "Lucknow", destination: "Goa" });
    expect(extractIntent("delhi to london fastest", NOW).patch).toMatchObject({ origin: "Delhi", destination: "London", priority: "fastest" });
  });
});

describe("/api/places", () => {
  beforeEach(() => _resetRateLimits());
  const get = (q: string, ip = "5.5.5.1") => new Request(`http://localhost/api/places?q=${encodeURIComponent(q)}`, { headers: { "x-forwarded-for": ip } });

  it("returns labelled suggestions and no coordinates", async () => {
    const { GET } = await import("@/app/api/places/route");
    const res = await GET(get("kanp"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.places.length).toBeGreaterThan(0);
    expect(body.places[0]).toEqual(expect.objectContaining({ id: expect.any(String), label: expect.any(String), kind: expect.any(String) }));
    expect(JSON.stringify(body)).not.toMatch(/"lat"|"lon"/);
  });
  it("validates input and rate-limits", async () => {
    const { GET } = await import("@/app/api/places/route");
    expect((await GET(get("a"))).status).toBe(400);
    expect((await GET(get("x".repeat(200)))).status).toBe(400);
    let last = 200;
    for (let i = 0; i < 95; i++) last = (await GET(get("kanp", "5.5.5.2"))).status;
    expect(last).toBe(429);
  });
});
