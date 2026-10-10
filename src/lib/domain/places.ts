import type { Terminal } from "./types";
import { AIRPORTS, countryName, regionOf, tzOffsetByIndex, type Region } from "../geo/data";

export type { Region };

/**
 * The ROUTE NETWORK: curated hub cities (hand-written Indian corridors keep their timetables) plus every
 * scheduled airport in the world as an automatic node. Any other place on Earth is mapped to its nearest node
 * (see geo/locate.ts). SERVER-ONLY: this module pulls in the ~4 MB place dataset.
 */
export interface City {
  id: string;
  name: string;
  country: string;
  cc: string;
  auto?: boolean; // generated from an airport rather than curated
  size?: 1 | 2 | 3; // airport class for auto nodes: 3 large, 2 medium, 1 small
  region: Region;
  lat: number;
  lon: number;
  utcOffsetMin: number; // fixed standard offset; daylight saving is NOT modelled in demo data
  iata: string | null; // null = no commercial airport in the demo network
  aliases: string[];
  globalHub?: boolean;
}

// [id, name, country, region, lat, lon, tz(min), iata, extra aliases, hub?]
type Row = [string, string, string, Region, number, number, number, string | null, string[]?, boolean?];

const ROWS: Row[] = [
  // ---- India (IST +5:30)
  ["jammu", "Jammu", "India", "in", 32.73, 74.87, 330, "IXJ", ["jammu tawi", "jammu city"]],
  ["delhi", "Delhi", "India", "in", 28.61, 77.21, 330, "DEL", ["new delhi", "ncr"], true],
  ["mumbai", "Mumbai", "India", "in", 19.08, 72.88, 330, "BOM", ["bombay"], true],
  ["bengaluru", "Bengaluru", "India", "in", 12.97, 77.59, 330, "BLR", ["bangalore"]],
  ["chennai", "Chennai", "India", "in", 13.08, 80.27, 330, "MAA", ["madras"]],
  ["kolkata", "Kolkata", "India", "in", 22.57, 88.36, 330, "CCU", ["calcutta"]],
  ["hyderabad", "Hyderabad", "India", "in", 17.39, 78.49, 330, "HYD"],
  ["pune", "Pune", "India", "in", 18.52, 73.86, 330, "PNQ"],
  ["ahmedabad", "Ahmedabad", "India", "in", 23.02, 72.57, 330, "AMD"],
  ["jaipur", "Jaipur", "India", "in", 26.91, 75.79, 330, "JAI"],
  ["lucknow", "Lucknow", "India", "in", 26.85, 80.95, 330, "LKO"],
  ["goa", "Goa", "India", "in", 15.38, 73.83, 330, "GOI", ["panaji", "panjim", "north goa", "south goa", "dabolim"]],
  ["kochi", "Kochi", "India", "in", 9.93, 76.27, 330, "COK", ["cochin", "ernakulam"]],
  ["chandigarh", "Chandigarh", "India", "in", 30.73, 76.78, 330, "IXC"],
  ["amritsar", "Amritsar", "India", "in", 31.63, 74.87, 330, "ATQ"],
  ["srinagar", "Srinagar", "India", "in", 34.08, 74.8, 330, "SXR"],
  ["leh", "Leh", "India", "in", 34.15, 77.58, 330, "IXL", ["ladakh"]],
  ["varanasi", "Varanasi", "India", "in", 25.32, 82.97, 330, "VNS", ["benares", "banaras", "kashi"]],
  ["patna", "Patna", "India", "in", 25.59, 85.14, 330, "PAT"],
  ["bhopal", "Bhopal", "India", "in", 23.26, 77.41, 330, "BHO"],
  ["indore", "Indore", "India", "in", 22.72, 75.86, 330, "IDR"],
  ["nagpur", "Nagpur", "India", "in", 21.15, 79.09, 330, "NAG"],
  ["guwahati", "Guwahati", "India", "in", 26.14, 91.74, 330, "GAU"],
  ["bhubaneswar", "Bhubaneswar", "India", "in", 20.3, 85.82, 330, "BBI"],
  ["visakhapatnam", "Visakhapatnam", "India", "in", 17.69, 83.22, 330, "VTZ", ["vizag"]],
  ["coimbatore", "Coimbatore", "India", "in", 11.02, 76.96, 330, "CJB"],
  ["udaipur", "Udaipur", "India", "in", 24.58, 73.71, 330, "UDR"],
  ["trivandrum", "Thiruvananthapuram", "India", "in", 8.52, 76.94, 330, "TRV", ["trivandrum", "tvm"]],
  ["madurai", "Madurai", "India", "in", 9.92, 78.12, 330, "IXM"],
  ["nagercoil", "Nagercoil", "India", "in", 8.18, 77.43, 330, null],
  ["kanyakumari", "Kanyakumari", "India", "in", 8.09, 77.54, 330, null, ["kanniyakumari", "cape comorin", "kanya kumari"]],
  // ---- South Asia
  ["kathmandu", "Kathmandu", "Nepal", "sas", 27.72, 85.32, 345, "KTM"],
  ["colombo", "Colombo", "Sri Lanka", "sas", 6.93, 79.86, 330, "CMB"],
  ["dhaka", "Dhaka", "Bangladesh", "sas", 23.81, 90.41, 360, "DAC"],
  ["male", "Malé", "Maldives", "sas", 4.18, 73.51, 300, "MLE", ["male maldives", "maldives"]],
  // ---- Middle East
  ["dubai", "Dubai", "UAE", "me", 25.2, 55.27, 240, "DXB", [], true],
  ["abudhabi", "Abu Dhabi", "UAE", "me", 24.45, 54.38, 240, "AUH"],
  ["doha", "Doha", "Qatar", "me", 25.29, 51.53, 180, "DOH", [], true],
  ["istanbul", "Istanbul", "Türkiye", "eu", 41.01, 28.98, 180, "IST", ["constantinople"], true],
  // ---- Europe
  ["london", "London", "United Kingdom", "eu", 51.51, -0.13, 0, "LHR", [], true],
  ["paris", "Paris", "France", "eu", 48.86, 2.35, 60, "CDG", [], true],
  ["frankfurt", "Frankfurt", "Germany", "eu", 50.11, 8.68, 60, "FRA", [], true],
  ["amsterdam", "Amsterdam", "Netherlands", "eu", 52.37, 4.9, 60, "AMS", [], true],
  ["madrid", "Madrid", "Spain", "eu", 40.42, -3.7, 60, "MAD", [], true],
  ["barcelona", "Barcelona", "Spain", "eu", 41.39, 2.17, 60, "BCN"],
  ["rome", "Rome", "Italy", "eu", 41.9, 12.5, 60, "FCO"],
  ["milan", "Milan", "Italy", "eu", 45.46, 9.19, 60, "MXP"],
  ["zurich", "Zurich", "Switzerland", "eu", 47.38, 8.54, 60, "ZRH"],
  ["berlin", "Berlin", "Germany", "eu", 52.52, 13.4, 60, "BER"],
  ["vienna", "Vienna", "Austria", "eu", 48.21, 16.37, 60, "VIE"],
  ["dublin", "Dublin", "Ireland", "eu", 53.35, -6.26, 0, "DUB"],
  ["lisbon", "Lisbon", "Portugal", "eu", 38.72, -9.14, 0, "LIS"],
  ["athens", "Athens", "Greece", "eu", 37.98, 23.73, 120, "ATH"],
  // ---- North America
  ["newyork", "New York", "USA", "na", 40.71, -74.0, -300, "JFK", ["nyc", "new york city"], true],
  ["losangeles", "Los Angeles", "USA", "na", 34.05, -118.24, -480, "LAX", ["la"], true],
  ["sanfrancisco", "San Francisco", "USA", "na", 37.77, -122.42, -480, "SFO", ["sf", "bay area"], true],
  ["chicago", "Chicago", "USA", "na", 41.88, -87.63, -360, "ORD", [], true],
  ["washington", "Washington DC", "USA", "na", 38.91, -77.04, -300, "IAD", ["washington dc", "dc"]],
  ["toronto", "Toronto", "Canada", "na", 43.65, -79.38, -300, "YYZ", [], true],
  ["vancouver", "Vancouver", "Canada", "na", 49.28, -123.12, -480, "YVR"],
  ["mexicocity", "Mexico City", "Mexico", "na", 19.43, -99.13, -360, "MEX", [], true],
  // ---- Latin America
  ["saopaulo", "São Paulo", "Brazil", "latam", -23.55, -46.63, -180, "GRU", ["sao paulo"], true],
  ["buenosaires", "Buenos Aires", "Argentina", "latam", -34.6, -58.38, -180, "EZE", [], true],
  // ---- East & South-East Asia
  ["singapore", "Singapore", "Singapore", "sea", 1.35, 103.82, 480, "SIN", [], true],
  ["kualalumpur", "Kuala Lumpur", "Malaysia", "sea", 3.14, 101.69, 480, "KUL", ["kl"]],
  ["bangkok", "Bangkok", "Thailand", "sea", 13.76, 100.5, 420, "BKK", [], true],
  ["hongkong", "Hong Kong", "China", "ea", 22.32, 114.17, 480, "HKG", [], true],
  ["shanghai", "Shanghai", "China", "ea", 31.23, 121.47, 480, "PVG", [], true],
  ["beijing", "Beijing", "China", "ea", 39.9, 116.4, 480, "PEK", [], true],
  ["tokyo", "Tokyo", "Japan", "ea", 35.68, 139.69, 540, "HND", [], true],
  ["osaka", "Osaka", "Japan", "ea", 34.69, 135.5, 540, "KIX"],
  ["seoul", "Seoul", "South Korea", "ea", 37.57, 126.98, 540, "ICN", [], true],
  // ---- Oceania
  ["sydney", "Sydney", "Australia", "oc", -33.87, 151.21, 600, "SYD", [], true],
  ["melbourne", "Melbourne", "Australia", "oc", -37.81, 144.96, 600, "MEL"],
  ["auckland", "Auckland", "New Zealand", "oc", -36.85, 174.76, 720, "AKL"],
  // ---- Africa
  ["cairo", "Cairo", "Egypt", "af", 30.04, 31.24, 120, "CAI", [], true],
  ["johannesburg", "Johannesburg", "South Africa", "af", -26.2, 28.05, 120, "JNB", [], true],
  ["nairobi", "Nairobi", "Kenya", "af", -1.29, 36.82, 180, "NBO"],
  ["lagos", "Lagos", "Nigeria", "af", 6.52, 3.38, 60, "LOS"],
];

const CC_OF: Record<string, string> = {
  India: "IN", Nepal: "NP", "Sri Lanka": "LK", Bangladesh: "BD", Maldives: "MV", UAE: "AE", Qatar: "QA", "Türkiye": "TR",
  "United Kingdom": "GB", France: "FR", Germany: "DE", Netherlands: "NL", Spain: "ES", Italy: "IT", Switzerland: "CH", Austria: "AT",
  Ireland: "IE", Portugal: "PT", Greece: "GR", USA: "US", Canada: "CA", Mexico: "MX", Brazil: "BR", Argentina: "AR", Singapore: "SG",
  Malaysia: "MY", Thailand: "TH", China: "CN", Japan: "JP", "South Korea": "KR", Australia: "AU", "New Zealand": "NZ", Egypt: "EG",
  "South Africa": "ZA", Kenya: "KE", Nigeria: "NG",
};

const curated: City[] = ROWS.map(([id, name, country, region, lat, lon, utcOffsetMin, iata, extra = [], hub]) => ({
  id, name, country, cc: CC_OF[country] ?? "", region, lat, lon, utcOffsetMin, iata, globalHub: hub,
  aliases: [...new Set([name.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, ""), id, ...(iata ? [iata.toLowerCase()] : []), ...extra])],
}));

// Hand-curated Indian corridor terminals (kept so curated timetables keep their original codes).
const CURATED: [string, string, string, Terminal["kind"]][] = [
  ["IXJ", "Jammu Airport", "jammu", "airport"], ["JAT", "Jammu Tawi Station", "jammu", "station"], ["JMBUS", "Jammu Bus Stand", "jammu", "bus_stand"],
  ["DEL", "Delhi Airport (IGI)", "delhi", "airport"], ["NDLS", "New Delhi Station", "delhi", "station"], ["DLBUS", "Delhi ISBT Kashmere Gate", "delhi", "bus_stand"],
  ["MAA", "Chennai Airport", "chennai", "airport"], ["MAS", "Chennai Central", "chennai", "station"], ["CHBUS", "Chennai CMBT", "chennai", "bus_stand"],
  ["BLR", "Bengaluru Airport", "bengaluru", "airport"], ["SBC", "Bengaluru City Station", "bengaluru", "station"], ["BLBUS", "Bengaluru Majestic Bus Stand", "bengaluru", "bus_stand"],
  ["BOM", "Mumbai Airport", "mumbai", "airport"],
  ["TRV", "Thiruvananthapuram Airport", "trivandrum", "airport"], ["TVC", "Thiruvananthapuram Central", "trivandrum", "station"], ["TVBUS", "Thampanoor Bus Stand", "trivandrum", "bus_stand"],
  ["IXM", "Madurai Airport", "madurai", "airport"], ["MDU", "Madurai Junction", "madurai", "station"], ["MDBUS", "Madurai Mattuthavani Bus Stand", "madurai", "bus_stand"],
  ["NCJ", "Nagercoil Junction", "nagercoil", "station"],
  ["CAPE", "Kanyakumari Station", "kanyakumari", "station"], ["KKBUS", "Kanyakumari Bus Stand", "kanyakumari", "bus_stand"],
];

// Curated station/bus codes (e.g. MAS, TVC) take priority over airports that happen to share the same 3 letters.
const RESERVED_CODES = new Set(CURATED.map((c) => c[0]));

function autoNodes(): City[] {
  const seen = new Set(curated.map((c) => c.iata).filter(Boolean) as string[]);
  const out: City[] = [];
  for (const [iata, type, name, lat, lon, cc, muni, sched, tzi] of AIRPORTS) {
    if (!iata || !sched || seen.has(iata) || RESERVED_CODES.has(iata)) continue;
    if (type !== "large_airport" && type !== "medium_airport" && type !== "small_airport") continue;
    seen.add(iata);
    out.push({
      id: `ap-${iata.toLowerCase()}`, name: muni ? `${muni} (${iata})` : name, country: countryName(cc), cc, region: regionOf(cc),
      lat, lon, utcOffsetMin: tzOffsetByIndex(tzi, lon), iata, aliases: [iata.toLowerCase()], auto: true, size: type === "large_airport" ? 3 : type === "medium_airport" ? 2 : 1,
    });
  }
  return out;
}

export const CITIES: City[] = [...curated, ...autoNodes()];

const cityById = new Map(CITIES.map((c) => [c.id, c]));


function buildTerminals(): Terminal[] {
  const base = (cityId: string) => {
    const c = cityById.get(cityId)!;
    return { cityId, cityName: c.name, country: c.country, utcOffsetMin: c.utcOffsetMin };
  };
  const out: Terminal[] = CURATED.map(([code, name, cityId, kind]) => ({ code, name, kind, ...base(cityId) }));
  const have = new Set(out.map((t) => `${t.cityId}|${t.kind}`));
  for (const c of CITIES) {
    const key = (c.iata ?? c.id.toUpperCase()).slice(0, 8);
    const label = c.auto ? c.name.replace(/ \([A-Z0-9]{3}\)$/, "") : c.name;
    if (c.iata && !have.has(`${c.id}|airport`)) out.push({ code: c.iata, name: `${label} Airport (${c.iata})`, kind: "airport", ...base(c.id) });
    if (!have.has(`${c.id}|station`)) out.push({ code: `${key}-STN`, name: `${label} Central Station`, kind: "station", ...base(c.id) });
    if (!have.has(`${c.id}|bus_stand`)) out.push({ code: `${key}-BUS`, name: `${label} Bus Station`, kind: "bus_stand", ...base(c.id) });
  }
  return out;
}

export const TERMINALS: Terminal[] = buildTerminals();
const terminalByCode = new Map(TERMINALS.map((t) => [t.code, t]));

export function terminal(code: string): Terminal {
  const t = terminalByCode.get(code);
  if (!t) throw new Error(`Unknown terminal ${code}`);
  return t;
}

const terminalsByCity = new Map<string, Terminal[]>();
for (const t of TERMINALS) (terminalsByCity.get(t.cityId) ?? terminalsByCity.set(t.cityId, []).get(t.cityId)!).push(t);

export function terminalsOfCity(cityId: string): Terminal[] {
  return terminalsByCity.get(cityId) ?? [];
}

export function getCity(id: string): City | undefined {
  return cityById.get(id);
}

export function cityName(id: string): string {
  return cityById.get(id)?.name ?? id;
}

// ---- matching -----------------------------------------------------------------------
const normalise = (s: string) =>
  s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z\s]/g, " ").replace(/\s+/g, " ").trim();

function lev(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)] as number[]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length][b.length];
}

/**
 * Resolve free text to a supported city: exact name/alias/IATA code, then a single unambiguous
 * near-match (1 typo for 5+ letters, 2 for 9+). Never guesses between several candidates.
 */
const aliasIndex = new Map<string, City>();
for (const c of CITIES) for (const a of c.aliases) { const k = normalise(a); if (k && !aliasIndex.has(k)) aliasIndex.set(k, c); }
const fuzzyPool = curated.flatMap((c) => c.aliases.filter((a) => a.length >= 5).map((a) => ({ c, key: normalise(a) })));

export function resolveCity(text: string): City | null {
  const q = normalise(text);
  if (!q) return null;
  const exact = aliasIndex.get(q);
  if (exact) return exact;
  if (q.length < 5) return null;
  const tol = q.length >= 9 ? 2 : 1;
  const hits = new Set(fuzzyPool.filter((x) => lev(x.key, q) <= tol).map((x) => x.c));
  return hits.size === 1 ? [...hits][0] : null;
}

/** Closest supported places for a query we could not resolve (for "did you mean" prompts). */
export function suggestCities(text: string, n = 3): City[] {
  const q = normalise(text);
  if (!q) return [];
  return curated.map((c) => {
    const best = Math.min(...c.aliases.map((a) => {
      const na = normalise(a);
      if (na.startsWith(q) || q.startsWith(na)) return 0;
      if (na.includes(q) || q.includes(na)) return 1;
      return lev(na, q);
    }));
    return { c, best };
  })
    .filter((x) => x.best <= Math.max(2, Math.floor(q.length / 2)))
    .sort((a, b) => a.best - b.best)
    .slice(0, n)
    .map((x) => x.c);
}

// ---- geography ----------------------------------------------------------------------
export function distanceKm(a: City, b: City): number {
  const R = 6371;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

const distCache = new Map<string, number>();
export function cityDistanceKm(aId: string, bId: string): number {
  const key = aId < bId ? `${aId}|${bId}` : `${bId}|${aId}`;
  let d = distCache.get(key);
  if (d === undefined) {
    const a = cityById.get(aId);
    const b = cityById.get(bId);
    d = a && b ? distanceKm(a, b) : Infinity;
    distCache.set(key, d);
  }
  return d;
}

/** Nearest supported city to a coordinate (computed locally; the coordinate never leaves the device). */
export function nearestCityTo(lat: number, lon: number): { city: City; km: number } {
  const probe = { lat, lon } as City;
  let best = CITIES[0];
  let bestKm = Infinity;
  for (const c of CITIES) {
    const km = distanceKm(probe, c);
    if (km < bestKm) { best = c; bestKm = km; }
  }
  return { city: best, km: Math.round(bestKm) };
}

/** Nearest curated cities or large airports (the nodes long-haul flights realistically use). */
export function nearestMajor(id: string, n: number): City[] {
  const c = cityById.get(id);
  if (!c) return [];
  return CITIES.filter((x) => x.id !== id && (!x.auto || x.size === 3))
    .sort((x, y) => distanceKm(c, x) - distanceKm(c, y))
    .slice(0, n);
}

export function nearestCities(id: string, n: number): City[] {
  const c = cityById.get(id);
  if (!c) return [];
  return CITIES.filter((x) => x.id !== id).sort((x, y) => distanceKm(c, x) - distanceKm(c, y)).slice(0, n);
}
