import type { Segment, Terminal } from "../domain/types";
import { inr } from "../domain/money";
import { toIsoOffset } from "../domain/time";

/** Rough, configured estimates (NOT quotes) for moving between terminals of the same city. */
const TABLE: Record<string, { minutes: number; low: number; expected: number; high: number }> = {
  "airport-station": { minutes: 60, low: 300, expected: 600, high: 1000 },
  "airport-bus_stand": { minutes: 70, low: 300, expected: 650, high: 1100 },
  "bus_stand-station": { minutes: 30, low: 80, expected: 180, high: 300 },
};

function key(a: Terminal, b: Terminal): string {
  return [a.kind, b.kind].sort().join("-");
}

export function groundMinutes(a: Terminal, b: Terminal): number | null {
  const e = TABLE[key(a, b)];
  return a.cityId === b.cityId && a.code !== b.code && e ? e.minutes : null;
}

export function buildGroundSegment(from: Terminal, to: Terminal, departMs: number, fetchedAt: string): Segment | null {
  const minutes = groundMinutes(from, to);
  if (minutes === null) return null;
  const e = TABLE[key(from, to)];
  return {
    id: `G-${from.code}-${to.code}@${departMs}`,
    serviceId: `G-${from.code}-${to.code}`,
    mode: "ground",
    operator: "Local taxi / transfer (estimate)",
    provider: "ground-estimate",
    from,
    to,
    departAt: toIsoOffset(departMs, from.utcOffsetMin),
    arriveAt: toIsoOffset(departMs + minutes * 60_000, from.utcOffsetMin),
    fare: inr(e.expected),
    fareKind: "estimated",
    fareLow: inr(e.low),
    fareHigh: inr(e.high),
    fareClass: "Estimate",
    source: "demo",
    fetchedAt,
    capability: "SEARCH_ONLY",
    refundable: null,
  };
}
