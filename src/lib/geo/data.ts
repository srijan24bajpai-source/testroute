// SERVER-ONLY: loads the generated place data (~4 MB). Never import this from a client component.
// Sources: GeoNames (CC BY 4.0, https://www.geonames.org) and OurAirports (public domain). See scripts/build-places.mjs.
import placesRaw from "@/data/places.json";
import airportsRaw from "@/data/airports.json";

export type Region = "in" | "sas" | "eu" | "na" | "latam" | "ea" | "sea" | "me" | "af" | "oc";

/** [geonamesId, name, asciiName, cc, admin1Code, lat, lon, population, tzIndex, alts("a|b")] */
export type CityRow = [number, string, string, string, string, number, number, number, number, string];
/** [iata, type, name, lat, lon, cc, municipality, scheduled(0|1), tzIndex] */
export type AirportRow = [string, string, string, number, number, string, string, number, number];
/** [cc, admin1Code, name, representativeCityIndex] */
export type StateRow = [string, string, string, number];

interface PlacesFile {
  countries: Record<string, [string, string]>;
  admin1: Record<string, string>;
  tz: string[];
  cities: CityRow[];
  states: StateRow[];
}

export const PLACES = placesRaw as unknown as PlacesFile;
export const AIRPORTS = airportsRaw as unknown as AirportRow[];

export const countryName = (cc: string) => PLACES.countries[cc]?.[0] ?? cc;
export const adminName = (cc: string, code: string) => (code ? PLACES.admin1[`${cc}.${code}`] ?? null : null);

const SOUTH_ASIA = new Set(["NP", "LK", "BD", "BT", "MV", "PK", "AF", "KZ", "UZ", "TM", "KG", "TJ"]);
const EAST_ASIA = new Set(["CN", "JP", "KR", "KP", "MN", "TW", "HK", "MO"]);
const SE_ASIA = new Set(["TH", "VN", "MY", "SG", "ID", "PH", "KH", "LA", "MM", "BN", "TL"]);

/** Coarse region used only to decide where generated trains/buses are plausible. */
export function regionOf(cc: string): Region {
  const continent = PLACES.countries[cc]?.[1];
  if (cc === "IN") return "in";
  if (continent === "EU") return "eu";
  if (continent === "NA") return "na";
  if (continent === "SA") return "latam";
  if (continent === "OC") return "oc";
  if (continent === "AF") return "af";
  if (SOUTH_ASIA.has(cc)) return "sas";
  if (EAST_ASIA.has(cc)) return "ea";
  if (SE_ASIA.has(cc)) return "sea";
  return "me"; // remaining Asia (Gulf, Levant, Caucasus, Iran, ...)
}

const offsetCache = new Map<string, number>();
/**
 * Standard (non-daylight-saving) UTC offset in minutes for an IANA zone. Demo data uses one fixed offset per place,
 * so daylight saving is NOT modelled; this picks the smaller of the January/July offsets.
 */
export function standardOffsetMin(tz: string): number {
  const cached = offsetCache.get(tz);
  if (cached !== undefined) return cached;
  let best = 0;
  try {
    const year = new Date().getUTCFullYear();
    const offs = [Date.UTC(year, 0, 1), Date.UTC(year, 6, 1)].map((t) => {
      const part = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "longOffset" }).formatToParts(new Date(t)).find((p) => p.type === "timeZoneName")?.value ?? "GMT";
      const m = part.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
      return m ? (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] ?? 0)) : 0;
    });
    best = Math.min(...offs);
  } catch {
    best = 0;
  }
  offsetCache.set(tz, best);
  return best;
}

export const tzOffsetByIndex = (i: number, lon: number) => (i >= 0 && PLACES.tz[i] ? standardOffsetMin(PLACES.tz[i]) : Math.round(lon / 15) * 60);
