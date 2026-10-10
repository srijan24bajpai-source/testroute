import { searchConfig } from "@/config/brand";
import type { Itinerary, Segment, Terminal } from "../domain/types";
import { inr } from "../domain/money";
import { parseTime, toIsoOffset } from "../domain/time";
import type { Located } from "../geo/locate";
import { assemble, type BuildOptions } from "./routes";

/** A pseudo-terminal for a place that is not itself a node of the route network (first/last mile). */
export function placeTerminal(loc: Located): Terminal {
  const p = loc.place!;
  return {
    code: `PL-${p.id}`, name: loc.label, cityId: `place:${p.id}`, cityName: p.name, country: p.country,
    kind: "place", utcOffsetMin: loc.node.utcOffsetMin,
  };
}

/** Road transfer ESTIMATE (not a quote): ~55 km/h plus 15 minutes, fare ~₹12/km (range ₹7–20/km). */
export function roadSegment(from: Terminal, to: Terminal, km: number, departMs: number, fetchedAt: string): Segment {
  const minutes = Math.round((km / 55) * 60) + 15;
  const offset = from.utcOffsetMin;
  return {
    id: `G-${from.code}-${to.code}@${departMs}`,
    serviceId: `G-${from.code}-${to.code}`,
    mode: "ground",
    operator: `Road transfer, about ${km} km (estimate)`,
    provider: "road-estimate",
    from, to,
    departAt: toIsoOffset(departMs, offset),
    arriveAt: toIsoOffset(departMs + minutes * 60_000, offset),
    fare: inr(km * 12), fareKind: "estimated", fareLow: inr(km * 7), fareHigh: inr(km * 20),
    fareClass: "Estimate", source: "demo", fetchedAt, capability: "SEARCH_ONLY", refundable: null,
  };
}

/** Add the first-mile / last-mile road legs around a network itinerary and recompute everything. */
export function addRoadLegs(it: Itinerary, start: Located, end: Located, passengers: number, o: BuildOptions): Itinerary {
  const first = it.segments[0];
  const last = it.segments[it.segments.length - 1];
  const fetchedAt = first.fetchedAt;
  const chain: Segment[] = [...it.segments];
  const flags: string[] = [];

  if (start.roadKm > 0) {
    const from = placeTerminal(start);
    const minutes = Math.round((start.roadKm / 55) * 60) + 15;
    const buffer = (o.boardingBuffer ?? searchConfig.boardingBuffer)[first.mode] ?? 30;
    const departMs = parseTime(first.departAt) - (buffer + minutes) * 60_000;
    chain.unshift(roadSegment(from, first.from, start.roadKm, departMs, fetchedAt));
    flags.push(`Starts with a road transfer of about ${start.roadKm} km from ${start.label} to ${first.from.name} (estimate; you arrange it).`);
  }
  if (end.roadKm > 0) {
    const to = placeTerminal(end);
    const deplane = (o.deplaneBuffer ?? searchConfig.deplaneBuffer)[last.mode] ?? 15;
    const departMs = parseTime(last.arriveAt) + (deplane + 10) * 60_000;
    chain.push(roadSegment(last.to, to, end.roadKm, departMs, fetchedAt));
    flags.push(`Ends with a road transfer of about ${end.roadKm} km from ${last.to.name} to ${end.label} (estimate; you arrange it).`);
  }
  const rebuilt = assemble(chain, it.connections, passengers, o);
  rebuilt.flags.push(...flags);
  return rebuilt;
}
