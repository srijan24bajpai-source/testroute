import type { Itinerary } from "./domain/types";
import { formatInr } from "./domain/money";
import { formatDuration } from "./domain/time";

/** One-sentence description of an itinerary (chat summary, read aloud). */
export function describeItinerary(it: Itinerary): string {
  const legs = it.segments.filter((s) => s.mode !== "ground");
  const path = [legs[0].from.cityName, ...legs.map((s) => s.to.cityName)].join(" to ");
  const modes = [...new Set(legs.map((s) => s.mode))].join(" and ");
  return `${path} by ${modes}, ${formatDuration(it.durationMinutes)}, ${formatInr(it.cost.expectedPerPerson)} per person`;
}

/**
 * Parse a spoken or typed rupee amount: "15000", "15,000 rupees", "15k", "15 thousand", "1.5 lakh".
 * Returns whole rupees, or null if no sensible amount is found. (Spelled-out numbers like "fifteen
 * thousand" are not parsed; browsers normally transcribe numbers as digits.)
 */
export function parseSpokenAmount(text: string): number | null {
  const m = text.toLowerCase().replace(/rupees?|rs\.?|₹|inr/g, " ").match(/(\d[\d,]*(?:\.\d+)?)\s*(k|thousand|lakhs?|lacs?)?/);
  if (!m) return null;
  let v = parseFloat(m[1].replace(/,/g, ""));
  if (m[2] === "k" || m[2] === "thousand") v *= 1000;
  else if (m[2]) v *= 100_000;
  return v > 0 && v <= 10_000_000 ? Math.round(v) : null;
}
