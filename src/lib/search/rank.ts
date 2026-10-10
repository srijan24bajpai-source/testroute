import type { Itinerary, SearchResult } from "../domain/types";
import { formatInr } from "../domain/money";
import { formatDuration } from "../domain/time";

export const VALUE_WEIGHTS = { price: 0.35, time: 0.35, transfers: 0.1, inconvenience: 0.2 } as const;

type Key = "fastest" | "cheapest" | "bestValue" | "convenient";

function norm(values: number[]): (v: number) => number {
  const min = Math.min(...values);
  const max = Math.max(...values);
  return (v) => (max === min ? 0 : (v - min) / (max - min));
}

/** Lower is better. Deterministic tie-breaks: id string order last. */
export function valueScores(its: Itinerary[]): Map<string, number> {
  const p = norm(its.map((i) => i.cost.expectedPerPerson));
  const t = norm(its.map((i) => i.durationMinutes));
  const x = norm(its.map((i) => i.transfers));
  const n = norm(its.map((i) => i.inconvenience));
  const out = new Map<string, number>();
  for (const i of its) {
    out.set(
      i.id,
      VALUE_WEIGHTS.price * p(i.cost.expectedPerPerson) +
        VALUE_WEIGHTS.time * t(i.durationMinutes) +
        VALUE_WEIGHTS.transfers * x(i.transfers) +
        VALUE_WEIGHTS.inconvenience * n(i.inconvenience),
    );
  }
  return out;
}

const cmp = (a: Itinerary, b: Itinerary, ...keys: ((i: Itinerary) => number)[]) => {
  for (const k of keys) {
    const d = k(a) - k(b);
    if (d !== 0) return d;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
};

export function rankAll(its: Itinerary[]): Record<Key, Itinerary[]> {
  const scores = valueScores(its);
  const price = (i: Itinerary) => i.cost.expectedPerPerson;
  const dur = (i: Itinerary) => i.durationMinutes;
  return {
    fastest: [...its].sort((a, b) => cmp(a, b, dur, price)),
    cheapest: [...its].sort((a, b) => cmp(a, b, price, dur)),
    bestValue: [...its].sort((a, b) => cmp(a, b, (i) => scores.get(i.id)!, dur)),
    convenient: [...its].sort((a, b) => cmp(a, b, (i) => i.inconvenience, (i) => i.transfers, dur, price)),
  };
}

function percentileBetter(its: Itinerary[], it: Itinerary, f: (i: Itinerary) => number): number {
  const worse = its.filter((o) => f(o) > f(it)).length;
  return its.length > 1 ? Math.round((worse / (its.length - 1)) * 100) : 100;
}

export function explain(its: Itinerary[], it: Itinerary, rankings: Record<Key, Itinerary[]>): string[] {
  const out: string[] = [];
  const labels: [Key, string][] = [
    ["fastest", "Fastest"],
    ["cheapest", "Cheapest"],
    ["bestValue", "Best value"],
    ["convenient", "Most convenient"],
  ];
  for (const [k, label] of labels) {
    const pos = rankings[k].findIndex((x) => x.id === it.id);
    if (pos >= 0 && pos < 3) out.push(`#${pos + 1} ${label}`);
  }
  out.push(
    `Takes ${formatDuration(it.durationMinutes)} — faster than ${percentileBetter(its, it, (i) => i.durationMinutes)}% of options.`,
    `Costs ${formatInr(it.cost.expectedPerPerson)} per person — cheaper than ${percentileBetter(its, it, (i) => i.cost.expectedPerPerson)}% of options.`,
    `${it.transfers} change${it.transfers === 1 ? "" : "s"}; inconvenience score ${it.inconvenience.toFixed(1)} (overnight waits/buses, odd hours, terminal changes, tight buffers).`,
  );
  return out;
}

export function buildResult(
  its: Itinerary[],
  providers: SearchResult["providers"],
  maxResults: number,
  now: Date,
): SearchResult {
  const rankings = rankAll(its);
  // Keep the union of each ranking's head so every mode's top picks are present.
  const keep = new Set<string>();
  for (const k of Object.keys(rankings) as Key[]) rankings[k].slice(0, Math.ceil(maxResults / 4)).forEach((i) => keep.add(i.id));
  const kept = rankings.bestValue.filter((i) => keep.has(i.id)).slice(0, maxResults);
  const keptIds = new Set(kept.map((i) => i.id));
  const pick = (k: Key) => rankings[k].filter((i) => keptIds.has(i.id)).map((i) => i.id);
  const explanations: Record<string, string[]> = {};
  for (const i of kept) explanations[i.id] = explain(its, i, rankings);

  const sources = new Set(kept.map((i) => i.source));
  return {
    itineraries: kept,
    rankings: { fastest: pick("fastest"), cheapest: pick("cheapest"), bestValue: pick("bestValue"), convenient: pick("convenient") },
    explanations,
    providers,
    partial: providers.some((p) => !p.ok),
    dataLabel: kept.length === 0 ? "none" : sources.size > 1 ? "mixed" : (sources.values().next().value as "demo" | "live"),
    generatedAt: now.toISOString(),
    notes: [
      `Best-value score = ${VALUE_WEIGHTS.price} × price + ${VALUE_WEIGHTS.time} × duration + ${VALUE_WEIGHTS.transfers} × changes + ${VALUE_WEIGHTS.inconvenience} × inconvenience (each min–max normalised across these results; lower is better).`,
    ],
  };
}
