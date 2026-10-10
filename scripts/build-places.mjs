// Builds src/data/places.json and src/data/airports.json from open datasets.
//   node scripts/build-places.mjs <dir containing the raw files>
// Raw files (download them yourself; treat as untrusted input and keep them OUTSIDE this repo):
//   cities15000.txt (unzipped), admin1CodesASCII.txt, countryInfo.txt  -> https://download.geonames.org/export/dump/  (CC BY 4.0)
//   airports.csv                                                       -> https://davidmegginson.github.io/ourairports-data/  (public domain)
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const rawDir = process.argv[2];
if (!rawDir) {
  console.error("usage: node scripts/build-places.mjs <raw data dir>");
  process.exit(1);
}
const outDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "data");
mkdirSync(outDir, { recursive: true });

const read = (f) => readFileSync(join(rawDir, f), "utf8");
const round = (n, d = 3) => Math.round(Number(n) * 10 ** d) / 10 ** d;

// ---- countries
const countries = {};
for (const line of read("countryInfo.txt").split("\n")) {
  if (!line || line.startsWith("#")) continue;
  const c = line.split("\t");
  countries[c[0]] = [c[4], c[8]]; // [name, continent code]
}

// ---- admin1 (states / provinces)
const admin1Names = {};
for (const line of read("admin1CodesASCII.txt").split("\n")) {
  if (!line) continue;
  const [code, , ascii] = line.split("\t");
  admin1Names[code] = ascii;
}

// ---- cities
const LATIN = /^[A-Za-z][A-Za-z .'\-]{1,29}$/;
const tzIndex = new Map();
const tzList = [];
const cities = [];
for (const line of read("cities15000.txt").split("\n")) {
  if (!line) continue;
  const c = line.split("\t");
  const [id, name, ascii, alt, lat, lon, , , cc, , a1, , , , pop, , , tz] = c;
  if (!tzIndex.has(tz)) { tzIndex.set(tz, tzList.length); tzList.push(tz); }
  const seen = new Set([name.toLowerCase(), ascii.toLowerCase()]);
  const alts = [];
  for (const a of alt.split(",")) {
    const k = a.toLowerCase();
    if (LATIN.test(a) && !seen.has(k)) { seen.add(k); alts.push(a); }
    if (alts.length >= 4) break;
  }
  cities.push([Number(id), name, ascii, cc, a1, round(lat), round(lon), Number(pop), tzIndex.get(tz), alts.join("|")]);
}

// ---- states: represented by their most populous city (no state centroids in the source files)
const best = new Map();
cities.forEach((c, i) => {
  const key = `${c[3]}.${c[4]}`;
  if (c[4] && (!best.has(key) || c[7] > cities[best.get(key)][7])) best.set(key, i);
});
const states = [];
for (const [key, idx] of best) {
  if (admin1Names[key]) states.push([key.split(".")[0], key.split(".")[1], admin1Names[key], idx]);
}

// Small list for the browser ("use my location" is computed on the device): cities with 250k+ people, plus state capitals' largest cities.
const label = (c) => {
  const a = admin1Names[`${c[3]}.${c[4]}`];
  return [c[1], a && a !== c[1] ? a : null, countries[c[3]][0]].filter(Boolean).join(", ");
};
const major = cities.filter((c) => c[7] >= 250000).map((c) => [label(c), c[5], c[6]]);
writeFileSync(join(outDir, "major-cities.json"), JSON.stringify(major));

writeFileSync(join(outDir, "places.json"), JSON.stringify({ countries, admin1: admin1Names, tz: tzList, cities, states }));

// ---- airports (OurAirports). Quoted-CSV parser.
function parseCsv(text) {
  const rows = [];
  let row = [], field = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; } else field += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (ch !== "\r") field += ch;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}
// Nearest city (for time zone) by a coarse grid so this stays fast.
const grid = new Map();
cities.forEach((c, i) => {
  const k = `${Math.floor(c[5] / 2)}:${Math.floor(c[6] / 2)}`;
  (grid.get(k) ?? grid.set(k, []).get(k)).push(i);
});
function nearestCityIdx(lat, lon) {
  let best = -1, bestD = Infinity;
  const gy = Math.floor(lat / 2), gx = Math.floor(lon / 2);
  for (let ring = 0; ring < 40 && best < 0; ring++) {
    for (let dy = -ring; dy <= ring; dy++) for (let dx = -ring; dx <= ring; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
      for (const i of grid.get(`${gy + dy}:${gx + dx}`) ?? []) {
        const c = cities[i];
        const d = (c[5] - lat) ** 2 + ((c[6] - lon) * Math.cos(lat * Math.PI / 180)) ** 2;
        if (d < bestD) { bestD = d; best = i; }
      }
    }
  }
  return best;
}
const csv = parseCsv(read("airports.csv"));
const h = Object.fromEntries(csv[0].map((n, i) => [n, i]));
const airports = [];
for (const r of csv.slice(1)) {
  if (r.length < 10) continue;
  const type = r[h.type];
  const iata = r[h.iata_code];
  const scheduled = r[h.scheduled_service] === "yes";
  // Keep airports people can actually fly to/from, plus coded heliports and seaplane bases (for charter options).
  const keep =
    ((type === "large_airport" || type === "medium_airport") && (iata || scheduled)) ||
    (type === "small_airport" && iata) ||
    ((type === "heliport" || type === "seaplane_base") && iata);
  if (!keep) continue;
  const lat = round(r[h.latitude_deg]), lon = round(r[h.longitude_deg]);
  const ci = nearestCityIdx(lat, lon);
  airports.push([iata, type, r[h.name], lat, lon, r[h.iso_country], r[h.municipality], scheduled ? 1 : 0, ci >= 0 ? cities[ci][8] : -1]);
}
writeFileSync(join(outDir, "airports.json"), JSON.stringify(airports));

console.log(JSON.stringify({ majorCities: major.length, countries: Object.keys(countries).length, cities: cities.length, states: states.length, airports: airports.length, timezones: tzList.length }));
