// SERVER-ONLY global place directory: ~34k cities (pop >= 15k), ~2.8k states/provinces, ~9k airports/heliports/seaplane bases.
// Data: GeoNames (CC BY 4.0) and OurAirports (public domain).
import { AIRPORTS, PLACES, adminName, countryName, tzOffsetByIndex, type AirportRow, type CityRow } from "./data";

export interface Place {
  id: string; // gn:<geonamesId> | st:<cc>.<admin1> | ap:<IATA>
  kind: "city" | "state" | "airport";
  name: string;
  admin: string | null;
  country: string;
  cc: string;
  lat: number;
  lon: number;
  pop: number;
  utcOffsetMin: number;
  label: string; // what the user sees and what we parse back: "Kanpur, Uttar Pradesh, India"
  iata?: string;
  airportType?: string;
}

export const norm = (s: string) =>
  s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, " ").trim();

function lev(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 2) return 9;
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)] as number[]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length][b.length];
}

const cityPlace = (r: CityRow): Place => {
  const [id, name, , cc, a1, lat, lon, pop, tzi] = r;
  const admin = adminName(cc, a1);
  const country = countryName(cc);
  return { id: `gn:${id}`, kind: "city", name, admin, country, cc, lat, lon, pop, utcOffsetMin: tzOffsetByIndex(tzi, lon), label: [name, admin && admin !== name ? admin : null, country].filter(Boolean).join(", ") };
};

const airportPlace = (r: AirportRow): Place => {
  const [iata, type, name, lat, lon, cc, muni, , tzi] = r;
  const country = countryName(cc);
  return { id: `ap:${iata}`, kind: "airport", name, admin: muni || null, country, cc, lat, lon, pop: 0, utcOffsetMin: tzOffsetByIndex(tzi, lon), label: `${name} (${iata}), ${country}`, iata, airportType: type };
};

// ---- indexes (built once, lazily) -------------------------------------------------------------
let ready = false;
const nameIndex = new Map<string, number[]>(); // normalised name/alias -> city row indexes
let sortedKeys: string[] = [];
const stateRows: Place[] = [];
const iataIndex = new Map<string, number>();
const airportNameKeys: { key: string; idx: number }[] = [];

function build() {
  if (ready) return;
  PLACES.cities.forEach((r, i) => {
    const keys = new Set([norm(r[1]), norm(r[2]), ...(r[9] ? r[9].split("|").map(norm) : [])]);
    for (const k of keys) if (k) (nameIndex.get(k) ?? nameIndex.set(k, []).get(k)!).push(i);
  });
  sortedKeys = [...nameIndex.keys()].sort();
  for (const [cc, code, name, rep] of PLACES.states) {
    const c = PLACES.cities[rep];
    const country = countryName(cc);
    stateRows.push({
      id: `st:${cc}.${code}`, kind: "state", name, admin: name, country, cc, lat: c[5], lon: c[6], pop: c[7],
      utcOffsetMin: tzOffsetByIndex(c[8], c[6]), label: `${name} (state/region), ${country}`,
    });
  }
  AIRPORTS.forEach((a, i) => {
    if (a[0]) iataIndex.set(a[0].toLowerCase(), i);
    if (a[0] && (a[1] === "large_airport" || a[1] === "medium_airport")) airportNameKeys.push({ key: norm(a[2]), idx: i });
  });
  ready = true;
}

function lowerBound(arr: string[], x: string): number {
  let lo = 0, hi = arr.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid] < x) lo = mid + 1; else hi = mid; }
  return lo;
}

const logPop = (p: number) => Math.log10(p + 1) * 10;

function hintScore(p: Place, hints: string[]): number {
  let s = 0;
  const admin = p.admin ? norm(p.admin) : "";
  const country = norm(p.country);
  for (const h of hints) {
    if ((admin && (admin === h || admin.startsWith(h))) || country === h || country.startsWith(h) || p.cc.toLowerCase() === h) s += 300;
  }
  return s;
}

export interface Scored { place: Place; score: number; how: "exact" | "prefix" | "fuzzy" }

/** Search cities, states/provinces and airports. Accepts "Kanpur", "Kanpur, Uttar Pradesh", "LHR", "Lucknow, India". */
export function searchScored(query: string, limit = 8, fuzzyTolerance?: number): Scored[] {
  build();
  // Our own labels come back as "Name (IATA), Country" or "Name (state/region), Country": parse them exactly.
  const code = query.match(/\(([A-Za-z0-9]{3})\)/);
  if (code && iataIndex.has(code[1].toLowerCase())) {
    return [{ place: airportPlace(AIRPORTS[iataIndex.get(code[1].toLowerCase())!]), score: 2000, how: "exact" }];
  }
  query = query.replace(/\(state\/region\)/i, "");
  const parts = query.slice(0, 120).split(",").map((s) => norm(s)).filter(Boolean);
  const head = parts[0];
  if (!head) return [];
  const hints = parts.slice(1);
  const found = new Map<string, Scored>();
  const add = (place: Place, base: number, how: Scored["how"] = "prefix") => {
    const score = base + hintScore(place, hints) + (place.kind === "airport" ? 0 : logPop(place.pop));
    const dedupe = `${place.kind}|${norm(place.name)}|${place.cc}|${place.admin ?? ""}`;
    const prev = found.get(dedupe);
    if (!prev || prev.score < score) found.set(dedupe, { place, score, how });
  };

  const exact = nameIndex.get(head);
  if (exact) for (const i of exact) add(cityPlace(PLACES.cities[i]), 1000, "exact");

  if (head.length >= 2 && (!exact || exact.length < limit)) {
    let n = 0;
    for (let k = lowerBound(sortedKeys, head); k < sortedKeys.length && sortedKeys[k].startsWith(head) && n < 300; k++, n++) {
      const key = sortedKeys[k];
      if (key === head) continue;
      for (const i of nameIndex.get(key)!) add(cityPlace(PLACES.cities[i]), 500 - (key.length - head.length));
    }
  }

  for (const s of stateRows) {
    const k = norm(s.name);
    if (k === head) add(s, 1050, "exact");
    else if (head.length >= 3 && k.startsWith(head)) add(s, 480);
  }

  if (head.length === 3 && iataIndex.has(head)) add(airportPlace(AIRPORTS[iataIndex.get(head)!]), 950, "exact");
  if (head.length >= 4) for (const a of airportNameKeys) if ((" " + a.key).includes(" " + head)) add(airportPlace(AIRPORTS[a.idx]), 450);

  if (found.size === 0 && head.length >= 4) {
    // one or two typos: same first letter, similar length
    const tol = fuzzyTolerance ?? (head.length >= 8 ? 2 : 1);
    let n = 0;
    for (const key of sortedKeys) {
      if (key[0] !== head[0] || Math.abs(key.length - head.length) > tol) continue;
      if (lev(key, head) <= tol) { for (const i of nameIndex.get(key)!) add(cityPlace(PLACES.cities[i]), 300, "fuzzy"); if (++n > 40) break; }
    }
  }

  return [...found.values()].sort((a, b) => b.score - a.score || a.place.id.localeCompare(b.place.id)).slice(0, limit);
}

/** Strict resolver for free-form chat: exact names/codes or a single close typo, never a mere prefix. */
export function resolvePlaceStrict(text: string): Place | null {
  const hit = searchScored(text, 4).find((s) => s.how !== "prefix");
  return hit ? hit.place : null;
}

export const searchPlaces = (q: string, limit = 8): Place[] => searchScored(q, limit).map((s) => s.place);

export interface Resolution { best: Place | null; alternatives: Place[] }

/** Resolve free text to one place. `alternatives` lists other plausible matches so callers can disambiguate. */
export function resolvePlaceText(text: string): Resolution {
  const r = searchScored(text, 6);
  return { best: r[0]?.place ?? null, alternatives: r.slice(1).map((x) => x.place) };
}

/** Airports/heliports/seaplane bases within `radiusKm` of a point, nearest first. */
export function airportsNear(lat: number, lon: number, radiusKm: number, filter?: (a: AirportRow) => boolean): { airport: AirportRow; km: number }[] {
  const rad = Math.PI / 180;
  const out: { airport: AirportRow; km: number }[] = [];
  for (const a of AIRPORTS) {
    if (filter && !filter(a)) continue;
    const dLat = (a[3] - lat) * rad, dLon = (a[4] - lon) * rad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat * rad) * Math.cos(a[3] * rad) * Math.sin(dLon / 2) ** 2;
    const km = 2 * 6371 * Math.asin(Math.sqrt(h));
    if (km <= radiusKm) out.push({ airport: a, km });
  }
  return out.sort((x, y) => x.km - y.km);
}

export const directoryStats = () => ({ cities: PLACES.cities.length, states: PLACES.states.length, airports: AIRPORTS.length, countries: Object.keys(PLACES.countries).length });
