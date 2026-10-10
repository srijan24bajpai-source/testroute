import { beforeEach, describe, expect, it } from "vitest";
import { ConstraintsSchema, type Constraints } from "@/lib/domain/types";
import { planJourney, PlaceError, resetBreakers } from "@/lib/search/plan";
import { DemoProvider } from "@/lib/providers/demo";
import { computeCost } from "@/lib/search/budget";
import { connect } from "@/lib/search/routes";
import { buildGroundSegment } from "@/lib/providers/ground";
import { terminal } from "@/lib/domain/places";
import { overlapsNight, istEpoch, toIstIso, formatDuration } from "@/lib/domain/time";
import type { Segment } from "@/lib/domain/types";
import type { SegmentProvider } from "@/lib/providers/types";

const NOW = new Date("2026-11-10T06:00:00Z");
const providers = () => [
  new DemoProvider("demo-flights", "f", "flight", () => NOW),
  new DemoProvider("demo-trains", "t", "train", () => NOW),
  new DemoProvider("demo-buses", "b", "bus", () => NOW),
];
const base = (over: Partial<Constraints> = {}): Constraints =>
  ConstraintsSchema.parse({ origin: "Jammu", destination: "Kanyakumari", date: "2026-11-15", ...over });
const run = (over: Partial<Constraints> = {}, ps: SegmentProvider[] = providers()) =>
  planJourney(base(over), { providers: ps, now: () => NOW });

beforeEach(() => resetBreakers());

describe("Jammu → Kanyakumari demo search", () => {
  it("returns ranked, demo-labelled itineraries", async () => {
    const r = await run();
    expect(r.itineraries.length).toBeGreaterThan(0);
    expect(r.dataLabel).toBe("demo");
    for (const it of r.itineraries) {
      expect(it.flags.some((f) => f.startsWith("Demo data"))).toBe(true);
      expect(it.segments[0].from.cityId).toBe("jammu");
      expect(it.segments.at(-1)!.to.cityId).toBe("kanyakumari");
    }
    expect(r.rankings.fastest.length).toBeGreaterThan(0);
    expect(r.rankings.cheapest.length).toBeGreaterThan(0);
  });

  it("fastest is not slower, and cheapest not dearer, than any other result", async () => {
    const r = await run();
    const by = new Map(r.itineraries.map((i) => [i.id, i]));
    const f = by.get(r.rankings.fastest[0])!;
    const c = by.get(r.rankings.cheapest[0])!;
    for (const i of r.itineraries) {
      expect(f.durationMinutes).toBeLessThanOrEqual(i.durationMinutes);
      expect(c.cost.expectedPerPerson).toBeLessThanOrEqual(i.cost.expectedPerPerson);
    }
  });

  it("never produces impossible connections", async () => {
    const r = await run();
    for (const it of r.itineraries) {
      for (let i = 1; i < it.segments.length; i++) {
        expect(Date.parse(it.segments[i].departAt)).toBeGreaterThanOrEqual(Date.parse(it.segments[i - 1].arriveAt));
      }
      for (const c of it.connections) expect(c.waitMinutes).toBeGreaterThanOrEqual(30);
    }
  });

  it("flags separate tickets on multi-leg trips", async () => {
    const r = await run();
    const multi = r.itineraries.find((i) => i.transfers > 0)!;
    expect(multi.flags.some((f) => f.startsWith("Separate tickets"))).toBe(true);
  });

  it("honours mode filters", async () => {
    const r = await run({ modes: ["train"] });
    for (const it of r.itineraries) expect(it.segments.every((s) => s.mode === "train" || s.mode === "ground")).toBe(true);
  });

  it("honours budget, transfer and arrive-by filters", async () => {
    const all = await run();
    const budget = 6000;
    const b = await run({ maxBudgetPerPerson: budget });
    for (const it of b.itineraries) expect(it.cost.expectedPerPerson).toBeLessThanOrEqual(budget * 100);
    expect(b.itineraries.length).toBeLessThan(all.itineraries.length);
    const t = await run({ maxTransfers: 1 });
    for (const it of t.itineraries) expect(it.transfers).toBeLessThanOrEqual(1);
    const a = await run({ arriveBy: "2026-11-16T09:00" });
    for (const it of a.itineraries) expect(Date.parse(it.arriveAt)).toBeLessThanOrEqual(Date.parse("2026-11-16T09:00:00+05:30"));
  });

  it("avoids overnight buses when asked", async () => {
    const r = await run({ avoidOvernightBuses: true });
    for (const it of r.itineraries)
      for (const s of it.segments.filter((x) => x.mode === "bus"))
        expect(overlapsNight(Date.parse(s.departAt), Date.parse(s.arriveAt))).toBe(false);
  });

  it("rejects unsupported places and identical endpoints", async () => {
    await expect(run({ origin: "Qzxwvland" })).rejects.toBeInstanceOf(PlaceError);
    await expect(run({ destination: "Jammu" })).rejects.toBeInstanceOf(PlaceError);
  });
});

describe("provider failure handling", () => {
  const failing: SegmentProvider = {
    id: "broken-flights", name: "x", mode: "flight", capability: "SEARCH_ONLY",
    isConfigured: () => true,
    searchSegments: async () => { throw new Error("secret-internal-detail api_key=abc"); },
  };
  const hanging: SegmentProvider = {
    id: "slow-buses", name: "x", mode: "bus", capability: "SEARCH_ONLY",
    isConfigured: () => true,
    searchSegments: (_q, signal) => new Promise((_res, rej) => signal.addEventListener("abort", () => rej(new Error("aborted")))),
  };

  it("reports partial results and redacts provider errors", async () => {
    const r = await planJourney(base(), { providers: [failing, new DemoProvider("demo-trains", "t", "train", () => NOW)], now: () => NOW });
    expect(r.partial).toBe(true);
    const st = r.providers.find((p) => p.providerId === "broken-flights")!;
    expect(st.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain("api_key");
    expect(r.itineraries.length).toBeGreaterThan(0);
  });

  it("times out slow providers", async () => {
    const r = await planJourney(base(), { providers: [hanging], now: () => NOW, timeoutMs: 50 });
    expect(r.providers[0].error).toBe("timed out");
    expect(r.itineraries).toEqual([]);
  });

  it("returns no fabricated results when no providers exist", async () => {
    const r = await planJourney(base(), { providers: [], now: () => NOW });
    expect(r.itineraries).toEqual([]);
    expect(r.dataLabel).toBe("none");
  });
});

describe("fare math", () => {
  const seg = (fare: number | null, kind: "quoted" | "estimated" = "quoted", low?: number, high?: number): Segment => ({
    id: `s${fare}${kind}`, serviceId: "x", mode: "train", operator: "Op",
    provider: "p", from: terminal("NDLS"), to: terminal("MAS"),
    departAt: "2026-11-15T10:00:00+05:30", arriveAt: "2026-11-15T12:00:00+05:30",
    fare: fare === null ? null : { amount: fare, currency: "INR" }, fareKind: kind,
    fareLow: low === undefined ? undefined : { amount: low, currency: "INR" },
    fareHigh: high === undefined ? undefined : { amount: high, currency: "INR" },
    fareClass: "3A", source: "live", fetchedAt: NOW.toISOString(), capability: "SEARCH_ONLY", refundable: null,
  });

  it("separates quoted and estimated amounts and multiplies by passengers", () => {
    const c = computeCost([seg(100_000), seg(60_000, "estimated", 30_000, 100_000)], 3);
    expect(c.quotedPerPerson).toBe(100_000);
    expect(c.estimatedPerPerson).toBe(60_000);
    expect(c.expectedPerPerson).toBe(160_000);
    expect(c.lowPerPerson).toBe(130_000);
    expect(c.highPerPerson).toBe(200_000);
    expect(c.expectedGroup).toBe(480_000);
    expect(c.confidence).toBe("estimated");
  });

  it("marks unknown components instead of treating them as zero cost", () => {
    const c = computeCost([seg(100_000), seg(null)], 2);
    expect(c.unknownComponents).toBe(1);
    expect(c.confidence).toBe("partial");
    expect(c.assumptions.join(" ")).toMatch(/no known price/);
  });
});

describe("connection logic and time helpers", () => {
  const mk = (fromCode: string, toCode: string, dep: string, arr: string, mode: Segment["mode"] = "train"): Segment => ({
    id: `${fromCode}${toCode}${dep}`, serviceId: "x", mode, operator: "Op", provider: "p",
    from: terminal(fromCode), to: terminal(toCode), departAt: dep, arriveAt: arr,
    fare: { amount: 1000, currency: "INR" }, fareKind: "quoted", fareClass: "x", source: "demo",
    fetchedAt: NOW.toISOString(), capability: "DEMO_ONLY", refundable: null,
  });
  const opts = { now: NOW };

  it("rejects connections inside the minimum buffer, accepts ones outside", () => {
    const a = mk("JAT", "NDLS", "2026-11-15T20:00:00+05:30", "2026-11-16T06:00:00+05:30");
    expect(connect(a, mk("NDLS", "MAS", "2026-11-16T06:30:00+05:30", "2026-11-17T10:00:00+05:30"), opts)).toBeNull();
    expect(connect(a, mk("NDLS", "MAS", "2026-11-16T08:00:00+05:30", "2026-11-17T10:00:00+05:30"), opts)).not.toBeNull();
  });

  it("inserts a ground transfer for a station→airport change and needs a bigger buffer", () => {
    const a = mk("JAT", "NDLS", "2026-11-15T20:00:00+05:30", "2026-11-16T06:00:00+05:30");
    const tooSoon = mk("DEL", "TRV", "2026-11-16T08:00:00+05:30", "2026-11-16T12:00:00+05:30", "flight");
    expect(connect(a, tooSoon, opts)).toBeNull();
    const ok = mk("DEL", "TRV", "2026-11-16T11:00:00+05:30", "2026-11-16T15:00:00+05:30", "flight");
    const j = connect(a, ok, opts)!;
    expect(j.bridge).toHaveLength(1);
    expect(j.bridge[0].fareKind).toBe("estimated");
    expect(j.connection.terminalChange).toBe(true);
  });

  it("rejects connections beyond max layover and across different cities", () => {
    const a = mk("JAT", "NDLS", "2026-11-15T20:00:00+05:30", "2026-11-16T06:00:00+05:30");
    expect(connect(a, mk("NDLS", "MAS", "2026-11-18T08:00:00+05:30", "2026-11-19T10:00:00+05:30"), opts)).toBeNull();
    expect(connect(a, mk("MAS", "CAPE", "2026-11-16T10:00:00+05:30", "2026-11-17T01:00:00+05:30"), opts)).toBeNull();
  });

  it("handles overnight windows and time zone offsets", () => {
    expect(overlapsNight(istEpoch("2026-11-15", "23:00"), istEpoch("2026-11-16", "01:00"))).toBe(true);
    expect(overlapsNight(istEpoch("2026-11-15", "08:00"), istEpoch("2026-11-15", "20:00"))).toBe(false);
    expect(toIstIso(Date.parse("2026-11-15T18:30:00Z"))).toBe("2026-11-16T00:00:00+05:30");
    expect(formatDuration(1500)).toBe("1d 1h");
  });

  it("builds ground segments only within one city", () => {
    expect(buildGroundSegment(terminal("NDLS"), terminal("MAS"), 0, NOW.toISOString())).toBeNull();
    expect(buildGroundSegment(terminal("NDLS"), terminal("DEL"), 0, NOW.toISOString())).not.toBeNull();
  });
});
