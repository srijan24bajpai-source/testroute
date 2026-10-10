import { describe, expect, it } from "vitest";
import { toSpeakable } from "@/components/useVoice";

describe("speech text clean-up", () => {
  it("reads rupee amounts and symbols naturally", () => {
    expect(toSpeakable("Fastest: Lucknow to Goa by flight, 3h 5m, ₹8,680 per person")).toBe(
      "Fastest: Lucknow to Goa by flight, 3h 5m, 8,680 rupees per person",
    );
    expect(toSpeakable("Delhi → London • ₹33,050 pp")).toBe("Delhi to London , 33,050 rupees per person");
  });
  it("collapses whitespace and handles empty input", () => {
    expect(toSpeakable("  a   b  ")).toBe("a b");
    expect(toSpeakable("")).toBe("");
  });
});

import { parseSpokenAmount } from "@/lib/describe";
describe("spoken budget parsing", () => {
  it("understands common ways of saying an amount", () => {
    expect(parseSpokenAmount("15000")).toBe(15000);
    expect(parseSpokenAmount("15,000 rupees")).toBe(15000);
    expect(parseSpokenAmount("my budget is ₹8,500")).toBe(8500);
    expect(parseSpokenAmount("15k")).toBe(15000);
    expect(parseSpokenAmount("15 thousand")).toBe(15000);
    expect(parseSpokenAmount("1.5 lakh")).toBe(150000);
  });
  it("rejects non-amounts and absurd values", () => {
    expect(parseSpokenAmount("no idea")).toBeNull();
    expect(parseSpokenAmount("0")).toBeNull();
    expect(parseSpokenAmount("99999999999")).toBeNull();
  });
});
