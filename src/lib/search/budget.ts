import type { CostBreakdown, CostComponent, Segment } from "../domain/types";

/**
 * Deterministic fare math. All values are integer paise.
 * Quoted fares (provider-supplied) are never mixed with estimates: they are tracked separately.
 */
export function computeCost(segments: Segment[], passengers: number): CostBreakdown {
  const components: CostComponent[] = segments.map((s) => {
    const label = `${s.operator} ${s.from.code}→${s.to.code}`;
    if (s.fare === null) {
      return { segmentId: s.id, label, kind: "unknown", perPerson: null, low: null, high: null };
    }
    if (s.fareKind === "estimated") {
      return {
        segmentId: s.id,
        label,
        kind: "estimated",
        perPerson: s.fare.amount,
        low: s.fareLow?.amount ?? null,
        high: s.fareHigh?.amount ?? null,
      };
    }
    return { segmentId: s.id, label, kind: "quoted", perPerson: s.fare.amount, low: s.fare.amount, high: s.fare.amount };
  });

  let quoted = 0;
  let estimated = 0;
  let low = 0;
  let high = 0;
  let unknown = 0;
  for (const c of components) {
    if (c.kind === "unknown") {
      unknown++;
      continue;
    }
    if (c.kind === "quoted") quoted += c.perPerson!;
    else estimated += c.perPerson!;
    // Without a defensible range, an estimate contributes its expected value to both ends.
    low += c.low ?? c.perPerson!;
    high += c.high ?? c.perPerson!;
  }

  const expected = quoted + estimated;
  const assumptions = [
    "Fares are per passenger and exclude payment-gateway or convenience fees unless the provider includes them.",
    "Child/senior/concession pricing is not applied; every passenger is priced at the adult fare.",
  ];
  if (estimated > 0) assumptions.push("Local transfer costs are estimates, not quoted prices.");
  if (unknown > 0) assumptions.push(`${unknown} component(s) have no known price and are excluded from totals.`);
  if (segments.some((s) => s.source === "demo")) assumptions.push("Demo data: not live availability or a bookable fare.");

  return {
    currency: "INR",
    components,
    quotedPerPerson: quoted,
    estimatedPerPerson: estimated,
    expectedPerPerson: expected,
    lowPerPerson: low,
    highPerPerson: high,
    passengers,
    expectedGroup: expected * passengers,
    lowGroup: low * passengers,
    highGroup: high * passengers,
    unknownComponents: unknown,
    confidence: unknown > 0 ? "partial" : estimated > 0 ? "estimated" : "quoted",
    assumptions,
  };
}
