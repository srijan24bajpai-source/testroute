import { searchConfig } from "@/config/brand";
import type { Connection, Constraints, Itinerary, Segment } from "../domain/types";
import { localMinuteOfDay, minutesBetween, offsetString, overlapsNight, parseTime } from "../domain/time";
import { cityDistanceKm } from "../domain/places";
import { buildGroundSegment, groundMinutes } from "../providers/ground";
import { computeCost } from "./budget";

export interface BuildOptions {
  now: Date;
  deplaneBuffer?: Record<string, number>;
  boardingBuffer?: Record<string, number>;
  maxLegs?: number;
  maxLayoverMinutes?: number;
  maxTotalMinutes?: number;
}

/** Minimum minutes between arrival of `prev` and departure of `next` at the same terminal. */
export function minConnectionMinutes(prev: Segment, next: Segment, o: BuildOptions): number {
  const deplane = (o.deplaneBuffer ?? searchConfig.deplaneBuffer)[prev.mode] ?? 15;
  const boarding = (o.boardingBuffer ?? searchConfig.boardingBuffer)[next.mode] ?? 30;
  return deplane + boarding;
}

/**
 * Try to join two segments. Returns the (possibly ground-transfer-bridged) chain or null if the
 * timing is impossible. A ground transfer is inserted when the terminals differ within one city.
 */
export function connect(prev: Segment, next: Segment, o: BuildOptions): { bridge: Segment[]; connection: Connection } | null {
  const arriveMs = parseTime(prev.arriveAt);
  const departMs = parseTime(next.departAt);
  const maxLayover = o.maxLayoverMinutes ?? searchConfig.maxLayoverMinutes;
  const sameTerminal = prev.to.code === next.from.code;

  let bridge: Segment[] = [];
  let readyMs = arriveMs;
  if (!sameTerminal) {
    if (prev.to.cityId !== next.from.cityId) return null;
    if (groundMinutes(prev.to, next.from) === null) return null;
    const g = buildGroundSegment(prev.to, next.from, arriveMs + (o.deplaneBuffer ?? searchConfig.deplaneBuffer)[prev.mode] * 60_000, prev.fetchedAt);
    if (!g) return null;
    bridge = [g];
    readyMs = parseTime(g.arriveAt);
    const board = (o.boardingBuffer ?? searchConfig.boardingBuffer)[next.mode] ?? 30;
    if (departMs < readyMs + board * 60_000) return null;
  } else if (departMs < arriveMs + minConnectionMinutes(prev, next, o) * 60_000) {
    return null;
  }

  const wait = minutesBetween(arriveMs, departMs);
  if (wait > maxLayover) return null;
  return {
    bridge,
    connection: {
      fromSegmentId: prev.id,
      toSegmentId: next.id,
      waitMinutes: wait,
      terminalChange: !sameTerminal,
      overnight: overlapsNight(arriveMs, departMs, prev.to.utcOffsetMin),
    },
  };
}

function itineraryId(segs: Segment[]): string {
  return segs.filter((s) => s.mode !== "ground").map((s) => s.id).join("+");
}

/** Assemble flags, totals and cost for an ordered chain of segments (ground bridges included). */
export function assemble(chain: Segment[], connections: Connection[], passengers: number, o: BuildOptions): Itinerary {
  const first = chain[0];
  const last = chain[chain.length - 1];
  const departMs = parseTime(first.departAt);
  const arriveMs = parseTime(last.arriveAt);
  const legs = chain.filter((s) => s.mode !== "ground");
  const flags: string[] = [];
  let inconvenience = 0;

  const tickets = new Set(legs.map((s) => s.ticketId ?? s.id));
  if (legs.length > 1 && tickets.size > 1) {
    flags.push("Separate tickets: each leg is booked and ticketed independently. If one leg is delayed or cancelled, later legs are not protected.");
    flags.push("Self-transfer: you must handle luggage, check-in and any terminal change yourself.");
  } else if (legs.length > 1) {
    flags.push("One ticket: the airline protects your connection if an earlier flight is delayed.");
  }
  if (connections.some((c) => c.terminalChange)) {
    flags.push("Includes a change of station/airport/bus stand within a city (local transfer estimated).");
    inconvenience += 0.5 * connections.filter((c) => c.terminalChange).length;
  }
  const overnightStops = connections.filter((c) => c.overnight).length;
  if (overnightStops) {
    flags.push("Includes an overnight wait between legs.");
    inconvenience += overnightStops;
  }
  for (const s of legs) {
    const dep = localMinuteOfDay(parseTime(s.departAt), s.from.utcOffsetMin);
    if (dep < 5 * 60) inconvenience += 1; // departs between 00:00 and 05:00 local time
    if (s.mode === "bus" && overlapsNight(parseTime(s.departAt), parseTime(s.arriveAt), s.from.utcOffsetMin)) {
      flags.push(`Overnight bus: ${s.from.name} → ${s.to.name}.`);
      inconvenience += 1;
    }
  }
  for (const c of connections) {
    const next = chain.find((s) => s.id === c.toSegmentId)!;
    const prev = chain.find((s) => s.id === c.fromSegmentId)!;
    const min = minConnectionMinutes(prev, next, o);
    if (!c.terminalChange && c.waitMinutes < min + 30) {
      flags.push(`Tight connection (${c.waitMinutes} min) at ${prev.to.name}.`);
      inconvenience += 0.5;
    }
  }
  if (chain.some((s) => s.source === "demo")) flags.push("Demo data — not live availability or a bookable fare.");

  const fetched = chain.map((s) => parseTime(s.fetchedAt));
  const oldest = Math.min(...fetched);
  const stale = o.now.getTime() - oldest > searchConfig.fareFreshnessMinutes * 60_000;
  if (stale) flags.push("Fares may be stale; they will be re-checked before booking.");

  const sources = new Set(legs.map((s) => s.source));
  return {
    id: itineraryId(chain),
    segments: chain,
    connections,
    departAt: first.departAt,
    arriveAt: last.arriveAt,
    durationMinutes: minutesBetween(departMs, arriveMs),
    transfers: Math.max(0, legs.length - 1),
    cost: computeCost(chain, passengers),
    flags,
    source: sources.size > 1 ? "mixed" : (sources.values().next().value ?? "demo"),
    oldestFetchedAt: new Date(oldest).toISOString(),
    stale,
    inconvenience,
  };
}

export function passesFilters(it: Itinerary, c: Constraints, o: BuildOptions): boolean {
  if (c.maxTransfers !== undefined && it.transfers > c.maxTransfers) return false;
  if (c.maxBudgetPerPerson !== undefined && it.cost.expectedPerPerson > c.maxBudgetPerPerson * 100) return false;
  // arriveBy is local time at the destination.
  const destOffset = it.segments[it.segments.length - 1].to.utcOffsetMin;
  if (c.arriveBy && parseTime(it.arriveAt) > parseTime(`${c.arriveBy}:00${offsetString(destOffset)}`)) return false;
  if (c.avoidOvernightStops && it.connections.some((x) => x.overnight)) return false;
  if (c.avoidOvernightBuses && it.segments.some((s) => s.mode === "bus" && overlapsNight(parseTime(s.departAt), parseTime(s.arriveAt), s.from.utcOffsetMin))) return false;
  if (it.durationMinutes > (o.maxTotalMinutes ?? searchConfig.maxTotalMinutes)) return false;
  return true;
}

/**
 * Build every valid multi-leg itinerary from a pool of segments (pure, deterministic).
 * `startOfDayMs`..`endOfDayMs` bound when the first leg may depart.
 */
export function buildItineraries(
  pool: Segment[],
  originCityId: string,
  destCityId: string,
  c: Constraints,
  o: BuildOptions,
  window: { fromMs: number; toMs: number },
): Itinerary[] {
  const maxLegs = o.maxLegs ?? searchConfig.maxLegs;
  const allowed = new Set<string>(c.modes);
  const segs = pool.filter((s) => s.mode !== "ground" && allowed.has(s.mode));
  const byFromCity = new Map<string, Segment[]>();
  for (const s of segs) {
    const arr = byFromCity.get(s.from.cityId) ?? [];
    arr.push(s);
    byFromCity.set(s.from.cityId, arr);
  }

  const departMs = new Map(segs.map((s) => [s.id, parseTime(s.departAt)]));
  for (const list of byFromCity.values()) list.sort((a, b) => departMs.get(a.id)! - departMs.get(b.id)!);

  const firstAtOrAfter = (list: Segment[], t: number) => {
    let lo = 0, hi = list.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (departMs.get(list[mid].id)! < t) lo = mid + 1; else hi = mid; }
    return lo;
  };

  // From any stop, only the K onward cities that get closest to the destination are explored (more from the origin).
  const topNextCache = new Map<string, Set<string>>();
  const topNext = (cityId: string, k: number): Set<string> => {
    const key = `${cityId}|${k}`;
    let set = topNextCache.get(key);
    if (!set) {
      const targets = [...new Set((byFromCity.get(cityId) ?? []).map((s) => s.to.cityId))];
      targets.sort((a, b) => cityDistanceKm(a, destCityId) - cityDistanceKm(b, destCityId));
      set = new Set(targets.slice(0, k));
      topNextCache.set(key, set);
    }
    return set;
  };
  const NEXT_CITIES = 8;
  const START_CITIES = 14;

  const found = new Map<string, Itinerary>();
  // Pruning keeps the global network tractable: every leg must make progress toward the destination,
  // and from each city only the earliest few departures per (next city, mode) are explored.
  // Search deepens one leg-count at a time (direct first), each first leg gets its own node budget, so
  // a long chain from an early departure can never starve a direct flight that leaves later in the day.
  const SLACK = 1.0;
  const PER_NEXT = 2;
  const MAX_VARIANTS = 3;
  const variants = new Map<string, number>();
  const TOTAL_NODES = 80_000;

  const starts = (byFromCity.get(originCityId) ?? []).filter((f) => {
    const dep = departMs.get(f.id)!;
    return dep >= window.fromMs && dep < window.toMs && (f.to.cityId === destCityId || topNext(originCityId, START_CITIES).has(f.to.cityId));
  });
  const budgetPerStart = Math.max(200, Math.floor(TOTAL_NODES / Math.max(1, starts.length) / maxLegs));

  for (let depthLimit = 1; depthLimit <= maxLegs; depthLimit++) {
    for (const first of starts) {
      let nodes = 0;
      const visit = (chain: Segment[], connections: Connection[], cities: string[]) => {
        if (++nodes > budgetPerStart) return;
        const last = chain[chain.length - 1];
        if (last.to.cityId === destCityId) {
          // The same path at different departure times is mostly noise: keep the first few (earliest) variants.
          const sig = chain.filter((s) => s.mode !== "ground").map((s) => `${s.from.cityId}>${s.to.cityId}:${s.mode}`).join("|");
          if ((variants.get(sig) ?? 0) >= MAX_VARIANTS) return;
          const it = assemble(chain, connections, c.passengers, o);
          if (passesFilters(it, c, o) && !found.has(it.id)) {
            found.set(it.id, it);
            variants.set(sig, (variants.get(sig) ?? 0) + 1);
          }
          return;
        }
        const legCount = chain.filter((s) => s.mode !== "ground").length;
        if (legCount >= depthLimit) return;
        const here = cityDistanceKm(last.to.cityId, destCityId);
        const taken = new Map<string, number>();
        const arriveMs = parseTime(last.arriveAt);
        const latestDepart = arriveMs + (o.maxLayoverMinutes ?? searchConfig.maxLayoverMinutes) * 60_000;
        const list = byFromCity.get(last.to.cityId) ?? [];
        for (let li = firstAtOrAfter(list, arriveMs); li < list.length; li++) {
          const next = list[li];
          const dep = departMs.get(next.id)!;
          if (dep > latestDepart) break; // lists are sorted by departure, so nothing later can connect
          if (cities.includes(next.to.cityId)) continue; // never revisit a city
          if (next.to.cityId !== destCityId && !topNext(last.to.cityId, NEXT_CITIES).has(next.to.cityId)) continue;
          if (cityDistanceKm(next.to.cityId, destCityId) > here * SLACK && next.to.cityId !== destCityId) continue;
          const joined = connect(last, next, o);
          if (!joined) continue;
          const key = `${next.to.cityId}|${next.mode}`;
          const n = taken.get(key) ?? 0;
          if (n >= PER_NEXT) continue;
          taken.set(key, n + 1);
          visit([...chain, ...joined.bridge, next], [...connections, joined.connection], [...cities, next.to.cityId]);
        }
      };
      visit([first], [], [originCityId, first.to.cityId]);
    }
  }
  return [...found.values()];
}
