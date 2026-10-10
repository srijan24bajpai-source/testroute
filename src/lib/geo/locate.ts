// SERVER-ONLY: maps what the traveller typed to a node of the route network, plus any road leg needed.
import { CITIES, distanceKm, resolveCity, type City } from "../domain/places";
import { resolvePlaceText, searchScored, type Place } from "./directory";

export interface Located {
  /** The route-network node the journey starts from / ends at. */
  node: City;
  /** The place the traveller actually meant (null when they named a network city directly). */
  place: Place | null;
  /** Estimated road distance between the place and the node's station/airport (0 = same city). */
  roadKm: number;
  label: string;
  alternatives: Place[];
}

const SAME_CITY_KM = 25;
const MAX_ROAD_KM = 700;
const ROAD_FACTOR = 1.3; // straight line -> road distance

/** Prefer bigger airports/stations among nodes that are about as close as the nearest. */
function bestNodeNear(lat: number, lon: number): { node: City; km: number } | null {
  const probe = { lat, lon } as Place;
  let nearest = Infinity;
  const scored: { node: City; km: number }[] = [];
  for (const n of CITIES) {
    const km = distanceKm(probe as never, n);
    scored.push({ node: n, km });
    if (km < nearest) nearest = km;
  }
  const pool = scored.filter((s) => s.km <= nearest + 60 && s.km <= MAX_ROAD_KM);
  if (!pool.length) return null;
  const rank = (s: { node: City; km: number }) => (s.node.auto ? (s.node.size ?? 1) : 4) * 50 - s.km;
  return pool.sort((a, b) => rank(b) - rank(a))[0];
}

/**
 * Resolve user text. Order: a network city/alias/airport code the planner already knows, then the global directory.
 * Returns null if nothing matches or the place is too far (> 700 km) from any scheduled airport.
 */
export function locate(text: string): Located | null {
  const direct = resolveCity(text);
  if (direct) return { node: direct, place: null, roadKm: 0, label: direct.name, alternatives: [] };

  const { best, alternatives } = resolvePlaceText(text);
  if (!best) return null;

  if (best.kind === "airport" && best.iata) {
    const node = CITIES.find((c) => c.iata === best.iata);
    if (node) return { node, place: best, roadKm: 0, label: best.label, alternatives };
  }
  const near = bestNodeNear(best.lat, best.lon);
  if (!near) return null;
  const roadKm = near.km <= SAME_CITY_KM ? 0 : Math.round(near.km * ROAD_FACTOR);
  return { node: near.node, place: best, roadKm, label: best.label, alternatives };
}

/** "Did you mean" suggestions across the whole directory. */
export function suggestLabels(text: string, n = 3): string[] {
  // Suggestions are lenient (up to 2 typos) because the user is already stuck.
  return searchScored(text, n, text.trim().length >= 6 ? 2 : 1).map((s) => s.place.label);
}
