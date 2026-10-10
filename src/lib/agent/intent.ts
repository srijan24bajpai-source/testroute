import { z } from "zod";
import { CITIES, resolveCity } from "../domain/places";
import { directoryStats, resolvePlaceStrict } from "../geo/directory";
import { suggestLabels } from "../geo/locate";
import { addDays } from "../domain/time";
import type { Constraints } from "../domain/types";

/**
 * Deterministic intent extraction. The (optional) LLM in llm.ts may only propose a partial
 * constraint patch, which is validated by the same schema. Nothing here can book, pay or
 * change permissions: the chat produces constraints and UI actions only.
 */
export type ChatAction =
  | { type: "search" }
  | { type: "select"; index: number }
  | { type: "book"; index: number }
  | { type: "sort"; priority: Constraints["priority"] }
  | { type: "none" };

export const PartialConstraints = z
  .object({
    origin: z.string().max(80),
    destination: z.string().max(80),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    passengers: z.number().int().min(1).max(9),
    modes: z.array(z.enum(["flight", "train", "bus"])).min(1),
    maxBudgetPerPerson: z.number().int().positive().max(10_000_000),
    arriveBy: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/),
    maxTransfers: z.number().int().min(0).max(3),
    avoidOvernightBuses: z.boolean(),
    avoidOvernightStops: z.boolean(),
    priority: z.enum(["fastest", "cheapest", "bestValue", "convenient"]),
  })
  .partial();
export type ConstraintPatch = z.infer<typeof PartialConstraints>;

const ORDINALS: Record<string, number> = { one: 1, first: 1, two: 2, second: 2, three: 3, third: 3, four: 4, fourth: 4, five: 5, fifth: 5 };
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

export function todayIst(now: Date): string {
  return new Date(now.getTime() + 330 * 60_000).toISOString().slice(0, 10);
}

function parseDate(t: string, now: Date): string | undefined {
  const today = todayIst(now);
  if (/\btoday\b/.test(t)) return today;
  if (/\bday after tomorrow\b/.test(t)) return addDays(today, 2);
  if (/\btomorrow\b/.test(t)) return addDays(today, 1);
  const iso = t.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (iso) return iso[0];
  const m = t.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*(?:\s+(\d{4}))?/);
  const m2 = t.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?/);
  const parts = m ? { d: +m[1], mo: MONTHS.indexOf(m[2]), y: m[3] ? +m[3] : undefined } : m2 ? { d: +m2[2], mo: MONTHS.indexOf(m2[1]), y: m2[3] ? +m2[3] : undefined } : null;
  if (!parts || parts.d < 1 || parts.d > 31) return undefined;
  let year = parts.y ?? +today.slice(0, 4);
  let cand = `${year}-${String(parts.mo + 1).padStart(2, "0")}-${String(parts.d).padStart(2, "0")}`;
  if (!parts.y && cand < today) cand = `${++year}-${cand.slice(5)}`;
  return Number.isNaN(Date.parse(cand)) ? undefined : cand;
}

function parseTimeOfDay(t: string): string | undefined {
  const m = t.match(/\b(?:before|by)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/);
  if (!m) return undefined;
  let h = +m[1];
  if (m[3] === "pm" && h < 12) h += 12;
  if (m[3] === "am" && h === 12) h = 0;
  if (h > 23) return undefined;
  return `${String(h).padStart(2, "0")}:${m[2] ?? "00"}`;
}

/**
 * Resolve a captured phrase to a city, tolerating filler words around it ("show me travel from lko",
 * "london fastest"). `keep` says which end of the phrase holds the place name: the origin phrase
 * ends with the city, the destination phrase starts with it.
 */
function resolvePhrase(text: string, keep: "start" | "end"): string | null {
  const words = text.trim().split(/\s+/).filter(Boolean);
  for (let n = Math.min(words.length, 4); n >= 1; n--) {
    const slice = (keep === "start" ? words.slice(0, n) : words.slice(words.length - n)).join(" ");
    const city = resolveCity(slice); // places the planner knows directly keep their short names
    if (city) return city.name;
    const place = resolvePlaceStrict(slice); // anywhere else on Earth (cities, states/regions, airports)
    if (place) return place.label;
  }
  return null;
}

export interface IntentResult {
  patch: ConstraintPatch;
  action: ChatAction;
  unknownPlaces: string[];
}

export function extractIntent(message: string, now: Date, prev?: Partial<Constraints>): IntentResult {
  const raw = message.slice(0, 500);
  const t = raw.toLowerCase();
  const patch: ConstraintPatch = {};
  const unknownPlaces: string[] = [];
  let action: ChatAction = { type: "none" };

  // Places: "from X to Y" or "X to Y".
  const fromTo = t.match(/\bfrom\s+([a-z\s]+?)\s+to\s+([a-z\s]+?)(?:\s+(?:on|by|before|for|under|with|in|via|tomorrow|today|next)\b|[,.]|\d|$)/) ??
    t.match(/^\s*([a-z\s]+?)\s+to\s+([a-z\s]+?)(?:\s+(?:on|by|before|for|under|with|in|via|tomorrow|today|next)\b|[,.]|\d|$)/);
  if (fromTo) {
    for (const [field, text] of [["origin", fromTo[1]], ["destination", fromTo[2]]] as const) {
      const name = resolvePhrase(text, field === "origin" ? "end" : "start");
      if (name) patch[field] = name;
      else unknownPlaces.push(text.trim());
    }
  } else {
    const only = t.match(/\bto\s+([a-z\s]+?)(?:\s+(?:on|by|before|for|under)\b|[,.]|\d|$)/);
    const name = only && resolvePhrase(only[1], "start");
    if (name) patch.destination = name;
  }
  if (!patch.origin && !patch.destination && !fromTo) {
    for (const c of CITIES) if (c.aliases.some((a) => a.length >= 4 && new RegExp(`\\b${a}\\b`).test(t)) && !prev?.origin) { patch.origin = c.name; break; }
  }

  const date = parseDate(t, now);
  if (date) patch.date = date;

  const pax = t.match(/\b(\d)\s*(?:people|persons|passengers|adults|travell?ers|pax)\b/) ?? t.match(/\bfor\s+(\d)\b(?!\s*(?:am|pm|k|000))/);
  if (pax) patch.passengers = Math.min(9, Math.max(1, +pax[1]));
  else if (/\bcouple\b/.test(t)) patch.passengers = 2;
  else if (/\b(solo|alone|just me)\b/.test(t)) patch.passengers = 1;

  const budget = t.match(/(?:under|below|within|max(?:imum)?|budget(?: of)?|less than)\s*(?:₹|rs\.?|inr)?\s*([\d,]+(?:\.\d+)?)\s*(k|thousand|lakh)?/);
  if (budget) {
    let v = parseFloat(budget[1].replace(/,/g, ""));
    if (budget[2] === "k" || budget[2] === "thousand") v *= 1000;
    if (budget[2] === "lakh") v *= 100_000;
    if (v > 0) patch.maxBudgetPerPerson = Math.round(v);
  }

  const tod = parseTimeOfDay(t);
  if (tod && /\barrive|reach|get there|be there\b/.test(t)) {
    const base = patch.date ?? prev?.date;
    if (base) patch.arriveBy = `${/\bnext day|following day\b/.test(t) ? addDays(base, 1) : base}T${tod}`;
  }

  const only = [/\bflights? only\b|\bonly flights?\b/.test(t) && "flight", /\btrains? only\b|\bonly trains?\b/.test(t) && "train", /\bbus(?:es)? only\b|\bonly bus(?:es)?\b/.test(t) && "bus"].filter(Boolean) as ("flight" | "train" | "bus")[];
  if (only.length) patch.modes = only;
  else if (/\b(no|avoid|without)\s+flights?\b/.test(t)) patch.modes = (prev?.modes ?? ["flight", "train", "bus"]).filter((m) => m !== "flight") as never;
  else if (/\b(no|avoid|without)\s+(?:buses|bus)\b/.test(t) && !/overnight/.test(t)) patch.modes = (prev?.modes ?? ["flight", "train", "bus"]).filter((m) => m !== "bus") as never;
  else if (/\b(no|avoid|without)\s+trains?\b/.test(t)) patch.modes = (prev?.modes ?? ["flight", "train", "bus"]).filter((m) => m !== "train") as never;

  if (/\bavoid\s+overnight\s+bus(?:es)?\b|\bno\s+overnight\s+bus(?:es)?\b/.test(t)) patch.avoidOvernightBuses = true;
  if (/\b(no|avoid|without)\s+overnight\s+(?:stops?|layovers?|waits?)\b/.test(t)) patch.avoidOvernightStops = true;
  if (/\bdirect\b|\bno (?:changes|transfers)\b/.test(t)) patch.maxTransfers = 0;
  const mt = t.match(/\b(?:max(?:imum)?|at most|up to)\s+(\d)\s+(?:changes|transfers|stops)\b/);
  if (mt) patch.maxTransfers = Math.min(3, +mt[1]);

  if (/\b(cheapest|lowest (?:price|cost)|least expensive)\b/.test(t)) { patch.priority = "cheapest"; action = { type: "sort", priority: "cheapest" }; }
  else if (/\b(fastest|quickest|shortest)\b/.test(t)) { patch.priority = "fastest"; action = { type: "sort", priority: "fastest" }; }
  else if (/\b(best value|balanced)\b/.test(t)) { patch.priority = "bestValue"; action = { type: "sort", priority: "bestValue" }; }
  else if (/\b(convenient|comfortable|easiest|least hassle)\b/.test(t)) { patch.priority = "convenient"; action = { type: "sort", priority: "convenient" }; }

  const pick = t.match(/\b(book|select|choose|take|go with|pick)\s+(?:option|number|itinerary|#)?\s*(\d|one|two|three|four|five|first|second|third|fourth|fifth)\b/);
  if (pick) {
    const index = ORDINALS[pick[2]] ?? +pick[2];
    action = { type: pick[1] === "book" ? "book" : "select", index };
  } else if (action.type === "none" && Object.keys(patch).length > 0) {
    action = { type: "search" };
  }
  return { patch, action, unknownPlaces };
}

export function missingFields(c: Partial<Constraints>): string[] {
  const out: string[] = [];
  if (!c.origin) out.push("origin");
  if (!c.destination) out.push("destination");
  if (!c.date) out.push("date");
  return out;
}

export function followUpQuestion(missing: string[], unknownPlaces: string[]): string {
  if (unknownPlaces.length) {
    const parts = unknownPlaces.map((p) => {
      const s = suggestLabels(p);
      return s.length ? `"${p}" (did you mean ${s.join("; ")}?)` : `"${p}"`;
    });
    const st = directoryStats();
    return `I couldn't find ${parts.join(" and ")} among ${st.cities.toLocaleString("en-US")} cities, ${st.states.toLocaleString("en-US")} states/regions and ${st.airports.toLocaleString("en-US")} airports. Try a city, state or airport code, e.g. "Kanpur", "Goa" or "LKO".`;
  }
  if (missing.includes("origin") && missing.includes("destination")) return "Where are you travelling from and to?";
  if (missing.includes("origin")) return "Where will you start your journey?";
  if (missing.includes("destination")) return "Where do you want to go?";
  if (missing.includes("date")) return "Which date do you want to travel on?";
  return "";
}

export function mergeConstraints(prev: Partial<Constraints> | undefined, patch: ConstraintPatch): Partial<Constraints> {
  return { ...(prev ?? {}), ...patch };
}
