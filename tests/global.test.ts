import { beforeEach, describe, expect, it } from "vitest";
import { ConstraintsSchema, type Constraints } from "@/lib/domain/types";
import { CITIES, resolveCity, suggestCities } from "@/lib/domain/places";
import { planJourney, resetBreakers } from "@/lib/search/plan";
import { getSegmentProviders } from "@/lib/providers/registry";
import { extractIntent, followUpQuestion } from "@/lib/agent/intent";
import { parseTime, formatLocal } from "@/lib/domain/time";

const NOW = new Date("2026-11-10T06:00:00Z");
const search = (o: Partial<Constraints>) =>
  planJourney(ConstraintsSchema.parse({ date: "2026-11-15", ...o }), { providers: getSegmentProviders(), now: () => NOW });

beforeEach(() => resetBreakers());

describe("place matching", () => {
  it("resolves the exact inputs that used to fail", () => {
    expect(resolveCity("lko")?.name).toBe("Lucknow");
    expect(resolveCity("Lucknow")?.name).toBe("Lucknow");
    expect(resolveCity("goa")?.name).toBe("Goa");
    expect(resolveCity("GOI")?.name).toBe("Goa");
  });
  it("handles codes, aliases, accents and single typos", () => {
    expect(resolveCity("LHR")?.name).toBe("London");
    expect(resolveCity("nyc")?.name).toBe("New York");
    expect(resolveCity("Bombay")?.name).toBe("Mumbai");
    expect(resolveCity("Sao Paulo")?.name).toBe("São Paulo");
    expect(resolveCity("bangalor")?.name).toBe("Bengaluru");
    expect(resolveCity("lucknw")?.name).toBe("Lucknow");
  });
  it("never guesses between candidates and rejects nonsense", () => {
    expect(resolveCity("qzxwvland")).toBeNull();
    expect(resolveCity("xyz")).toBeNull();
    expect(CITIES.length).toBeGreaterThan(70);
  });
  it("suggests close matches", () => {
    expect(suggestCities("luckno").map((c) => c.name)).toContain("Lucknow");
  });
  it("chat parses the user's original messages", () => {
    const now = NOW;
    expect(extractIntent("show me travel from lko to goa", now).patch).toMatchObject({ origin: "Lucknow", destination: "Goa" });
    expect(extractIntent("Lucknow to Goa", now).patch).toMatchObject({ origin: "Lucknow", destination: "Goa" });
    expect(extractIntent("delhi to london fastest", now).patch).toMatchObject({ origin: "Delhi", destination: "London", priority: "fastest" });
  });
  it("unknown place replies suggest instead of dumping a list", () => {
    const r = extractIntent("from lucnoww to goa", NOW);
    const msg = followUpQuestion(["date"], r.unknownPlaces);
    expect(msg).toMatch(/Lucknow/);
    expect(msg.length).toBeLessThan(300);
  });
});

describe("global search", () => {
  it("Lucknow → Goa returns demo itineraries (previously an error)", async () => {
    const r = await search({ origin: "Lucknow", destination: "Goa" });
    expect(r.itineraries.length).toBeGreaterThan(0);
    expect(r.dataLabel).toBe("demo");
    expect(r.itineraries[0].segments[0].from.cityId).toBe("lucknow");
    expect(r.itineraries.at(-1)!.segments.at(-1)!.to.cityId).toBe("goa");
  });

  it("works with airport codes", async () => {
    const r = await search({ origin: "LKO", destination: "GOI" });
    expect(r.itineraries.length).toBeGreaterThan(0);
  });

  it("Delhi → London offers flights and sensible durations", async () => {
    const r = await search({ origin: "Delhi", destination: "London", modes: ["flight"] });
    expect(r.itineraries.length).toBeGreaterThan(0);
    const fastest = r.itineraries.find((i) => i.id === r.rankings.fastest[0])!;
    expect(fastest.durationMinutes).toBeGreaterThan(8 * 60);
    expect(fastest.durationMinutes).toBeLessThan(40 * 60);
  });

  it("uses local time at each end: elapsed time is absolute, labels are local", async () => {
    const r = await search({ origin: "Delhi", destination: "London", modes: ["flight"], maxTransfers: 0 });
    const it = r.itineraries[0];
    const seg = it.segments[0];
    expect(seg.departAt).toMatch(/\+05:30$/); // Delhi
    expect(seg.arriveAt).toMatch(/\+00:00$/); // London (standard time)
    const elapsed = (parseTime(seg.arriveAt) - parseTime(seg.departAt)) / 60_000;
    expect(elapsed).toBe(it.durationMinutes);
    expect(formatLocal(seg.arriveAt)).toMatch(/^\d+ \w{3}, \d{2}:\d{2}$/);
  });

  it("arrive-by is interpreted in destination local time", async () => {
    const all = await search({ origin: "Delhi", destination: "London", modes: ["flight"] });
    const latest = all.itineraries.map((i) => i.arriveAt.slice(0, 16)).sort().at(-1)!;
    const early = await search({ origin: "Delhi", destination: "London", modes: ["flight"], arriveBy: latest });
    expect(early.itineraries.length).toBeGreaterThan(0);
    for (const i of early.itineraries) expect(i.arriveAt.slice(0, 16) <= latest).toBe(true);
    const none = await search({ origin: "Delhi", destination: "London", modes: ["flight"], arriveBy: "2026-11-15T00:30" });
    expect(none.itineraries.length).toBe(0);
  });

  it("long-haul across hubs: Lucknow → New York connects via hubs", async () => {
    const r = await search({ origin: "Lucknow", destination: "New York", modes: ["flight"] });
    expect(r.itineraries.length).toBeGreaterThan(0);
    for (const it of r.itineraries) expect(it.transfers).toBeGreaterThanOrEqual(1);
  });

  it("trains and buses only appear where plausible (no train across oceans)", async () => {
    const r = await search({ origin: "Delhi", destination: "London", modes: ["train", "bus"] });
    expect(r.itineraries).toEqual([]);
  });

  it("Europe has ground options: Paris → Amsterdam by train", async () => {
    const r = await search({ origin: "Paris", destination: "Amsterdam", modes: ["train"] });
    expect(r.itineraries.length).toBeGreaterThan(0);
  });

  it("stays fast on the global network", async () => {
    const t0 = Date.now();
    await search({ origin: "Sydney", destination: "Lucknow" });
    await search({ origin: "Jammu", destination: "Kanyakumari" });
    expect(Date.now() - t0).toBeLessThan(8000);
  });

  it("still rejects truly unknown places with a suggestion", async () => {
    await expect(search({ origin: "Lucknw", destination: "Qzxwvland" })).rejects.toMatchObject({ field: "destination" });
    await expect(search({ origin: "Lucnoww", destination: "Goa" })).rejects.toThrow(/Did you mean Lucknow/);
  });
});
