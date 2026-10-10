import type { Mode } from "../domain/types";
import { distanceKm, getCity, terminalsOfCity, type City } from "../domain/places";
import type { DemoService } from "./demo-data";

/**
 * SYNTHETIC timetable generator for city pairs without a hand-curated service.
 * Durations and fares come from great-circle distance and simple formulas: they are plausible
 * but NOT real schedules or fares, and are always labelled as demo data.
 */

type M = Exclude<Mode, "ground">;

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

const RAIL: Partial<Record<City["region"], number>> = { in: 2800, eu: 1800, ea: 2200 };
const BUS: Partial<Record<City["region"], number>> = { in: 900, eu: 900, na: 800, latam: 800, ea: 700, sea: 700 };

const SLOTS: Record<M, string[]> = {
  flight: ["06:25", "11:50", "17:35", "22:40"],
  train: ["07:10", "15:20", "21:45"],
  bus: ["08:30", "14:00", "21:00"],
};
const COUNT: Record<M, number> = { flight: 3, train: 2, bus: 2 };

function bump(hhmm: string, minutes: number): string {
  const [h, m] = hhmm.split(":").map(Number);
  const t = (h * 60 + m + minutes) % 1440;
  return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
}

/** Is a generated service of this mode plausible between the two cities? */
export function modeAllowed(mode: M, a: City, b: City): boolean {
  const d = distanceKm(a, b);
  if (mode === "flight") {
    if (!a.iata || !b.iata || d < 250) return false;
    if (d < 2500) return true; // short/medium haul: point-to-point
    if (d < 6000) return !!a.globalHub || !!b.globalHub; // needs a major hub at one end
    return !!a.globalHub && !!b.globalHub; // ultra-long-haul only between major hubs; others connect via hubs
  }
  if (a.region !== b.region) return false;
  if (mode === "train") return d >= 40 && d <= (RAIL[a.region] ?? 0);
  return d >= 20 && d <= (BUS[a.region] ?? 0);
}

export function generateServices(mode: M, fromId: string, toId: string): DemoService[] {
  const a = getCity(fromId);
  const b = getCity(toId);
  if (!a || !b || a.id === b.id || !modeAllowed(mode, a, b)) return [];
  const kind = mode === "flight" ? "airport" : mode === "train" ? "station" : "bus_stand";
  const from = terminalsOfCity(a.id).find((t) => t.kind === kind);
  const to = terminalsOfCity(b.id).find((t) => t.kind === kind);
  if (!from || !to) return [];

  const km = distanceKm(a, b);
  const h = hash(`${mode}|${a.id}|${b.id}`);
  const start = h % SLOTS[mode].length;
  const shiftMin = (h % 7) * 5;
  const out: DemoService[] = [];
  for (let i = 0; i < COUNT[mode]; i++) {
    const dep = bump(SLOTS[mode][(start + i) % SLOTS[mode].length], shiftMin);
    const jitter = [1.0, 0.88, 1.22][(h + i) % 3];
    let durMin: number;
    let fare: number;
    if (mode === "flight") {
      durMin = Math.round(75 + (km / 800) * 60);
      fare = (2500 + km * 5 + (a.country !== b.country ? 1500 : 0)) * jitter;
    } else if (mode === "train") {
      durMin = Math.round(30 + (km / 75) * 60);
      fare = (200 + km * 0.9) * jitter;
    } else {
      durMin = Math.round(30 + (km / 48) * 60);
      fare = (100 + km * 1.0) * jitter;
    }
    out.push({
      mode, from: from.code, to: to.code, dep, durMin, fareInr: Math.round(fare / 10) * 10,
      operator: mode === "flight" ? "Demo Air" : mode === "train" ? "Demo Rail" : "Demo Bus Lines",
      cls: mode === "flight" ? "Economy" : mode === "train" ? "Standard" : "AC Seater",
    });
  }
  return out;
}
