// SERVER-ONLY. Charter-style ways to travel (private jet, helicopter, seaplane). There is no public price or availability
// feed for these, so we NEVER show a fare: only whether the endpoints plausibly support the mode, and where to ask for quotes.
import type { CharterOption } from "../domain/types";
import { distanceKm } from "../domain/places";
import type { AirportRow } from "./data";
import { airportsNear } from "./directory";
import type { Located } from "./locate";

const point = (l: Located) => ({ lat: l.place?.lat ?? l.node.lat, lon: l.place?.lon ?? l.node.lon });
const label = (a: AirportRow) => `${a[2]} (${a[0]})`;
const isFixedWing = (a: AirportRow) => a[1] === "large_airport" || a[1] === "medium_airport" || a[1] === "small_airport";

function quoteLink(kind: string, from: string, to: string) {
  return { label: `Find ${kind} operators`, url: `https://www.google.com/search?q=${encodeURIComponent(`${kind} charter ${from} to ${to}`)}` };
}

export function charterOptions(start: Located, end: Located): CharterOption[] {
  const a = point(start);
  const b = point(end);
  const d = Math.round(distanceKm(a as never, b as never));
  const out: CharterOption[] = [];
  const near = (p: { lat: number; lon: number }, r: number, f: (x: AirportRow) => boolean) => airportsNear(p.lat, p.lon, r, f)[0]?.airport;

  // Private jet: any airport with a code at both ends.
  const jetA = near(a, 80, isFixedWing);
  const jetB = near(b, 80, isFixedWing);
  if (jetA && jetB && d >= 80) {
    out.push({
      mode: "private_jet", fromSite: label(jetA), toSite: label(jetB), distanceKm: d,
      note: d > 7500 ? "Beyond the range of most business jets without a fuel stop; ask about ultra-long-range aircraft."
        : d < 250 ? "Very short for a jet; a helicopter or road transfer is usually more practical."
        : "Price and availability depend on aircraft, dates and operators; request quotes.",
      link: quoteLink("private jet", start.label, end.label),
    });
  }

  // Helicopter: short hops only (typical range ~400–600 km), from a heliport or airport at each end.
  if (d <= 450) {
    const heliA = near(a, 40, (x) => x[1] === "heliport" || isFixedWing(x));
    const heliB = near(b, 40, (x) => x[1] === "heliport" || isFixedWing(x));
    if (heliA && heliB) {
      out.push({
        mode: "helicopter", fromSite: label(heliA), toSite: label(heliB), distanceKm: d,
        note: "Helicopter charters suit short hops (typical range 400–600 km). Landing permissions, weather and daylight limits apply.",
        link: quoteLink("helicopter", start.label, end.label),
      });
    }
  }

  // Seaplane: needs a coded seaplane base near both ends.
  if (d <= 600) {
    const seaA = near(a, 120, (x) => x[1] === "seaplane_base");
    const seaB = near(b, 120, (x) => x[1] === "seaplane_base");
    if (seaA && seaB) {
      out.push({
        mode: "seaplane", fromSite: label(seaA), toSite: label(seaB), distanceKm: d,
        note: "Seaplanes operate between water bases, often seasonally and in daylight only.",
        link: quoteLink("seaplane", start.label, end.label),
      });
    }
  }
  return out;
}
