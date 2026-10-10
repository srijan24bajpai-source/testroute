import { ConstraintsSchema } from "@/lib/domain/types";
import type { Itinerary, Segment } from "@/lib/domain/types";
import { planJourney } from "@/lib/search/plan";
import { DemoProvider } from "@/lib/providers/demo";
import type { BookingPassenger, BookingProvider, ProviderBookResult, ProviderQuote, SegmentProvider } from "@/lib/providers/types";

export const NOW = new Date("2026-11-10T06:00:00Z");

/**
 * TEST DOUBLE ONLY. Never registered in the app: it lets the booking state machine be exercised
 * without any real provider, money or tickets.
 */
export class SandboxBookingProvider implements BookingProvider {
  readonly id = "sandbox";
  capability: BookingProvider["capability"] = "CANCEL_SUPPORTED";
  priceDelta = 0;
  behaviour: "confirm" | "timeout" | "decline" | "pending" | "noref" = "confirm";
  bookCalls = 0;
  private attempts = new Map<string, ProviderBookResult>();
  constructor(private fares: Map<string, number>) {}

  async refreshQuote(segmentIds: string[], passengers: number): Promise<ProviderQuote> {
    void passengers;
    const per = segmentIds.reduce((s, id) => s + (this.fares.get(id) ?? 0), 0) + this.priceDelta;
    return { segmentIds, totalPerPerson: per, currency: "INR", fareVersion: `v${this.priceDelta}`, expiresAt: "2099-01-01T00:00:00Z" };
  }
  async book(args: { segmentIds: string[]; passengers: BookingPassenger[]; expectedTotal: number; idempotencyKey: string }): Promise<ProviderBookResult> {
    this.bookCalls++;
    const prior = this.attempts.get(args.idempotencyKey);
    if (prior) return prior;
    let r: ProviderBookResult;
    switch (this.behaviour) {
      case "decline": r = { outcome: "DECLINED", reason: "sold out" }; break;
      case "pending": r = { outcome: "PAYMENT_PENDING", paymentUrl: "https://pay.example.test/x", externalRef: "SBX-PEND-1" }; break;
      case "noref": r = { outcome: "CONFIRMED", externalRef: "" }; break;
      case "timeout":
        this.attempts.set(args.idempotencyKey, { outcome: "CONFIRMED", externalRef: "SBX-LATE-1" }); // provider did succeed
        throw new Error("network timeout");
      default: r = { outcome: "CONFIRMED", externalRef: `SBX-${this.bookCalls}` };
    }
    this.attempts.set(args.idempotencyKey, r);
    return r;
  }
  async lookup(key: string): Promise<ProviderBookResult> {
    return this.attempts.get(key) ?? { outcome: "UNKNOWN" };
  }
  async cancel(): Promise<{ outcome: "CANCELLED" | "REFUND_PENDING" | "REJECTED" }> {
    return { outcome: "REFUND_PENDING" };
  }
}

/** Demo segments re-labelled as belonging to the sandbox provider so an itinerary can be "bookable". */
export function sandboxProviders(capability: Segment["capability"] = "CANCEL_SUPPORTED"): SegmentProvider[] {
  return (["flight", "train", "bus"] as const).map((mode) => {
    const inner = new DemoProvider(`inner-${mode}`, mode, mode, () => NOW);
    return {
      id: `sandbox-${mode}`, name: mode, mode, capability, isConfigured: () => true,
      searchSegments: async (q, s) => (await inner.searchSegments(q, s)).map((x) => ({ ...x, provider: "sandbox", capability, source: "live" as const })),
    };
  });
}

export async function directItinerary(capability: Segment["capability"] = "CANCEL_SUPPORTED"): Promise<Itinerary> {
  const c = ConstraintsSchema.parse({ origin: "Chennai", destination: "Kanyakumari", date: "2026-11-15", modes: ["train"], maxTransfers: 0, passengers: 2 });
  const r = await planJourney(c, { providers: sandboxProviders(capability), now: () => NOW });
  if (!r.itineraries.length) throw new Error("fixture itinerary missing");
  return r.itineraries[0];
}

export function fareMap(it: Itinerary): Map<string, number> {
  return new Map(it.segments.filter((s) => s.mode !== "ground").map((s) => [s.id, s.fare!.amount]));
}

export const pax: BookingPassenger[] = [{ fullName: "Test Traveller One", age: 30 }, { fullName: "Test Traveller Two", age: 28 }];
