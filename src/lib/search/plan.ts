import { searchConfig } from "@/config/brand";
import type { Constraints, Itinerary, ProviderStatus, SearchResult, Segment } from "../domain/types";
import type { Located } from "../geo/locate";
import { CITIES, cityDistanceKm, nearestCities, nearestMajor } from "../domain/places";
import { directoryStats } from "../geo/directory";
import { locate, suggestLabels } from "../geo/locate";
import { charterOptions } from "../geo/charter";
import { airportsNear } from "../geo/directory";
import type { LiveFlightSource } from "../providers/duffel";
import { addDays, localEpoch } from "../domain/time";
import type { SegmentProvider } from "../providers/types";
import { buildItineraries, passesFilters } from "./routes";
import { addRoadLegs } from "./roadleg";
import { buildResult } from "./rank";

function placeMessage(field: string, text: string): string {
  const s = suggestLabels(text);
  const stats = directoryStats();
  return `We couldn't find "${text}" among ${stats.cities.toLocaleString("en-US")} cities, ${stats.states.toLocaleString("en-US")} states/regions and ${stats.airports.toLocaleString("en-US")} airports, or it is more than 700 km from any scheduled airport.` + (s.length ? ` Did you mean ${s.join("; ")}?` : "");
}

/** Cities whose segments are fetched: origin, destination, global hubs, and the nearest cities to each end. */
export function hubsFor(originId: string, destId: string): string[] {
  const ids = new Set<string>([originId, destId]);
  for (const c of CITIES) if (c.globalHub) ids.add(c.id);
  for (const id of [originId, destId]) {
    for (const n of nearestCities(id, 7)) ids.add(n.id);
    for (const n of nearestMajor(id, 3)) ids.add(n.id); // feeder to the long-haul network, however remote the place
  }
  return [...ids];
}

export class PlaceError extends Error {
  constructor(public field: "origin" | "destination", message: string) {
    super(message);
  }
}

// --- simple per-provider circuit breaker (process-local) ---------------------------------
const breaker = new Map<string, { failures: number; openUntil: number }>();
const BREAKER_THRESHOLD = 5;
const BREAKER_COOLDOWN_MS = 30_000;

export function resetBreakers() {
  breaker.clear();
}

function breakerOpen(id: string, nowMs: number): boolean {
  const b = breaker.get(id);
  return !!b && b.openUntil > nowMs;
}

function recordResult(id: string, ok: boolean, nowMs: number) {
  const b = breaker.get(id) ?? { failures: 0, openUntil: 0 };
  if (ok) {
    breaker.set(id, { failures: 0, openUntil: 0 });
    return;
  }
  b.failures += 1;
  if (b.failures >= BREAKER_THRESHOLD) b.openUntil = nowMs + BREAKER_COOLDOWN_MS;
  breaker.set(id, b);
}

async function withTimeout<T>(fn: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await Promise.race([
      fn(ctrl.signal),
      new Promise<never>((_, rej) => ctrl.signal.addEventListener("abort", () => rej(new Error("timeout")))),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export interface PlanDeps {
  providers: SegmentProvider[];
  /** Optional LIVE flight fares (e.g. Duffel). When it returns offers they replace the demo flights. */
  liveFlights?: LiveFlightSource | null;
  now?: () => Date;
  timeoutMs?: number;
}

/** Search is idempotent and read-only, so one retry is safe (never done for bookings). */
async function runProvider(
  p: SegmentProvider,
  queries: { fromCityId: string; toCityId: string; date: string }[],
  timeoutMs: number,
  nowMs: number,
): Promise<{ status: ProviderStatus; segments: Segment[] }> {
  const t0 = Date.now();
  if (breakerOpen(p.id, nowMs)) {
    return { status: { providerId: p.id, ok: false, segments: 0, ms: 0, error: "temporarily disabled (circuit open)" }, segments: [] };
  }
  const attempt = async () => {
    const results = await withTimeout(
      (signal) => Promise.all(queries.map((q) => p.searchSegments(q, signal))),
      timeoutMs,
    );
    return results.flat();
  };
  try {
    let segments: Segment[];
    try {
      segments = await attempt();
    } catch {
      segments = await attempt();
    }
    recordResult(p.id, true, nowMs);
    return { status: { providerId: p.id, ok: true, segments: segments.length, ms: Date.now() - t0 }, segments };
  } catch (e) {
    recordResult(p.id, false, nowMs);
    // Error text is deliberately generic: provider internals are not exposed to clients.
    return { status: { providerId: p.id, ok: false, segments: 0, ms: Date.now() - t0, error: e instanceof Error && e.message === "timeout" ? "timed out" : "unavailable" }, segments: [] };
  }
}

export async function planJourney(c: Constraints, deps: PlanDeps): Promise<SearchResult> {
  const now = (deps.now ?? (() => new Date()))();
  const start = locate(c.origin);
  const end = locate(c.destination);
  if (!start) throw new PlaceError("origin", placeMessage("origin", c.origin));
  if (!end) throw new PlaceError("destination", placeMessage("destination", c.destination));
  const origin = start.node;
  const dest = end.node;
  if (origin.id === dest.id) {
    throw new PlaceError("destination", start.label === end.label
      ? "Origin and destination must differ."
      : `${start.label} and ${end.label} are both served by ${origin.name}, so they are close enough to travel between by road.`);
  }
  const originOffset = origin.utcOffsetMin;

  const cities = hubsFor(origin.id, dest.id);
  const dates = [0, 1, 2, 3, 4].map((d) => addDays(c.date, d));
  const queries: { fromCityId: string; toCityId: string; date: string }[] = [];
  // Only fetch pairs the search can use: nothing leaves the destination, nothing returns to the origin, and (after the
  // first leg) every hop must get closer to the destination.
  for (const a of cities) {
    if (a === dest.id) continue;
    const dA = cityDistanceKm(a, dest.id);
    for (const b of cities) {
      if (a === b || b === origin.id) continue;
      if (a !== origin.id && b !== dest.id && cityDistanceKm(b, dest.id) > dA) continue;
      for (const date of dates) queries.push({ fromCityId: a, toCityId: b, date });
    }
  }

  const enabled = deps.providers.filter((p) => (c.modes as string[]).includes(p.mode));
  const ran = await Promise.all(enabled.map((p) => runProvider(p, queries, deps.timeoutMs ?? searchConfig.providerTimeoutMs, now.getTime())));
  const pool = ran.flatMap((r) => r.segments);
  const statuses = ran.map((r) => r.status);

  const opts = { now, maxLayoverMinutes: c.maxLayoverHours ? c.maxLayoverHours * 60 : undefined };
  // With first/last-mile road legs, budget and deadline are judged on the FINAL itinerary, not the network part.
  const needsRoad = start.roadKm > 0 || end.roadKm > 0;
  const baseConstraints = needsRoad ? { ...c, maxBudgetPerPerson: undefined, arriveBy: undefined } : c;
  let its = buildItineraries(
    pool,
    origin.id,
    dest.id,
    baseConstraints,
    opts,
    // "date" is the local calendar day at the origin.
    { fromMs: localEpoch(c.date, "00:00", originOffset), toMs: localEpoch(addDays(c.date, 1), "00:00", originOffset) },
  );
  // ---- live flights (optional): real fares replace the demo flights; trains/buses stay demo and labelled as such
  let liveNote: string | null = null;
  if (deps.liveFlights && (c.modes as string[]).includes("flight")) {
    const live = await fetchLiveFlights(deps.liveFlights, start, end, c, now);
    statuses.push(live.status);
    if (live.itineraries.length > 0) {
      its = its.filter((it) => !it.segments.some((s) => s.mode === "flight"));
      const kept = live.itineraries.map((it) => (needsRoad ? addRoadLegs(it, start, end, c.passengers, opts) : it)).filter((it) => passesFilters(it, c, opts));
      its = [...kept, ...its];
      liveNote = `Live flight fares from ${deps.liveFlights.id} (${kept.length}). Train and bus options below are demo data.`;
    }
  }
  if (needsRoad) its = its.map((it) => addRoadLegs(it, start, end, c.passengers, opts)).filter((it) => passesFilters(it, c, opts));
  const result = buildResult(its, statuses, searchConfig.maxResults, now);
  result.charter = charterOptions(start, end);
  if (liveNote) result.notes.push(liveNote);
  if (needsRoad) result.notes.push(`Route network nodes used: ${origin.name} (for ${start.label}) and ${dest.name} (for ${end.label}). Road transfers are estimates.`);
  if (enabled.length === 0) result.notes.push("No travel providers are enabled for the selected modes.");
  if (its.length === 0 && !result.partial) result.notes.push("No itinerary matched your constraints. Try relaxing the budget, deadline or mode filters.");
  if (result.partial) result.notes.push("Some providers did not respond; results may be incomplete.");
  return result;
}

/** Query the live source for the nearest large airports at each end (max 2 x 2 searches), merge and dedupe. */
async function fetchLiveFlights(src: LiveFlightSource, start: Located, end: Located, c: Constraints, now: Date) {
  const t0 = Date.now();
  const nearAirports = (lat: number, lon: number, fallbackIata: string | undefined) => {
    const found = airportsNear(lat, lon, 120, (a) => !!a[0] && (a[1] === "large_airport" || a[1] === "medium_airport") && a[7] === 1).slice(0, 2).map((x) => x.airport[0]);
    return found.length ? found : fallbackIata ? [fallbackIata] : [];
  };
  const o = nearAirports(start.place?.lat ?? start.node.lat, start.place?.lon ?? start.node.lon, start.node.iata ?? undefined);
  const d = nearAirports(end.place?.lat ?? end.node.lat, end.place?.lon ?? end.node.lon, end.node.iata ?? undefined);
  const jobs: Promise<Itinerary[]>[] = [];
  for (const originIata of o) for (const destIata of d) if (originIata !== destIata) jobs.push(src.search({ originIata, destIata, date: c.date, passengers: c.passengers }, now));
  const settled = await Promise.allSettled(jobs);
  const itineraries = new Map<string, Itinerary>();
  let failed = 0;
  for (const r of settled) {
    if (r.status === "fulfilled") for (const it of r.value) itineraries.set(it.id, it);
    else failed++;
  }
  const status: ProviderStatus = { providerId: src.id, ok: failed < settled.length || settled.length === 0, segments: itineraries.size, ms: Date.now() - t0, ...(failed ? { error: failed === settled.length ? "unavailable" : "partly unavailable" } : {}) };
  return { itineraries: [...itineraries.values()], status };
}
