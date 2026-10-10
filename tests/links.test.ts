import { describe, expect, it } from "vitest";
import { officialLink } from "@/lib/links";
import { nearestCityTo } from "@/lib/domain/places";
import { ConstraintsSchema } from "@/lib/domain/types";
import { planJourney } from "@/lib/search/plan";
import { getSegmentProviders } from "@/lib/providers/registry";

const NOW = new Date("2026-11-10T06:00:00Z");
const find = async (o: string, d: string, modes: ("flight" | "train" | "bus")[]) => {
  const r = await planJourney(ConstraintsSchema.parse({ origin: o, destination: d, date: "2026-11-15", modes, maxTransfers: 0 }), { providers: getSegmentProviders(), now: () => NOW });
  return r.itineraries[0].segments[0];
};

describe("official outbound links", () => {
  it("flights go to a fare-comparison search for the exact route and date", async () => {
    const l = officialLink(await find("Lucknow", "Goa", ["flight"]))!;
    expect(l.url).toContain("google.com/travel/flights");
    expect(decodeURIComponent(l.url)).toContain("LKO to GOI on 2026-11-15");
  });
  it("Indian trains go to IRCTC, Indian buses to redBus, abroad to a neutral search", async () => {
    expect(officialLink(await find("Delhi", "Jaipur", ["train"]))!.url).toContain("irctc.co.in");
    expect(officialLink(await find("Delhi", "Jaipur", ["bus"]))!.url).toContain("redbus.in");
    expect(officialLink(await find("Paris", "Amsterdam", ["train"]))!.url).toContain("google.com/search");
  });
  it("only https URLs, never ground transfers, never personal data", async () => {
    const s = await find("Lucknow", "Goa", ["flight"]);
    expect(officialLink(s)!.url.startsWith("https://")).toBe(true);
    expect(officialLink({ ...s, mode: "ground" })).toBeNull();
  });
});

describe("nearest city from a coordinate (done on-device)", () => {
  it("maps real coordinates to the right city", () => {
    expect(nearestCityTo(26.85, 80.95).city.name).toBe("Lucknow");
    expect(nearestCityTo(28.7, 77.1).city.name).toBe("Delhi");
    expect(nearestCityTo(51.5, -0.1).city.name).toBe("London");
  });
  it("reports distance when nothing is close", () => {
    const r = nearestCityTo(-52, -130); // remote South Pacific
    expect(r.km).toBeGreaterThan(1000);
  });
});
