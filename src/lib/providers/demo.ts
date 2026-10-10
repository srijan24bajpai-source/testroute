import type { Mode, Segment } from "../domain/types";
import { inr } from "../domain/money";
import { terminal, terminalsOfCity } from "../domain/places";
import { localEpoch, toIsoOffset } from "../domain/time";
import { DEMO_SERVICES, type DemoService } from "./demo-data";
import { generateServices } from "./generator";
import type { SegmentProvider, SegmentQuery } from "./types";

// Pairs that have a hand-curated timetable; the generator only fills the gaps.
const curatedPairs = new Set(DEMO_SERVICES.map((s) => `${s.mode}|${terminal(s.from).cityId}|${terminal(s.to).cityId}`));

/** Demo provider: synthetic data only. Capability is DEMO_ONLY, so it can never issue a ticket. */
export class DemoProvider implements SegmentProvider {
  readonly capability = "DEMO_ONLY" as const;
  constructor(
    readonly id: string,
    readonly name: string,
    readonly mode: Exclude<Mode, "ground">,
    private now: () => Date = () => new Date(),
  ) {}

  isConfigured() {
    return true;
  }

  private servicesFor(q: SegmentQuery): DemoService[] {
    if (curatedPairs.has(`${this.mode}|${q.fromCityId}|${q.toCityId}`)) {
      const fromCodes = new Set(terminalsOfCity(q.fromCityId).map((t) => t.code));
      const toCodes = new Set(terminalsOfCity(q.toCityId).map((t) => t.code));
      return DEMO_SERVICES.filter((s) => s.mode === this.mode && fromCodes.has(s.from) && toCodes.has(s.to));
    }
    return generateServices(this.mode, q.fromCityId, q.toCityId);
  }

  async searchSegments(q: SegmentQuery, signal: AbortSignal): Promise<Segment[]> {
    if (signal.aborted) throw new Error("aborted");
    const fetchedAt = this.now().toISOString();
    return this.servicesFor(q).map((s) => {
      const from = terminal(s.from);
      const to = terminal(s.to);
      const departMs = localEpoch(q.date, s.dep, from.utcOffsetMin); // departure date/time is local at the origin
      const arriveMs = departMs + s.durMin * 60_000; // elapsed time is absolute
      const serviceId = `${this.mode[0].toUpperCase()}-${s.from}-${s.to}-${s.dep.replace(":", "")}`;
      return {
        id: `${serviceId}@${q.date}`,
        serviceId,
        mode: this.mode,
        operator: s.operator,
        provider: this.id,
        from,
        to,
        departAt: toIsoOffset(departMs, from.utcOffsetMin),
        arriveAt: toIsoOffset(arriveMs, to.utcOffsetMin), // shown as local time at the destination
        fare: inr(s.fareInr),
        fareKind: "quoted" as const,
        fareClass: s.cls,
        source: "demo" as const,
        fetchedAt,
        capability: this.capability,
        refundable: null,
      };
    });
  }
}
