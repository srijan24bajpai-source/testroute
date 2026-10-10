import { z } from "zod";

export type Mode = "flight" | "train" | "bus" | "ground";
export type Capability = "SEARCH_ONLY" | "QUOTE_AND_BOOK" | "CANCEL_SUPPORTED" | "DEMO_ONLY";
export type DataSource = "live" | "demo";

/** Money is always integer minor units (paise). */
export interface Money {
  amount: number;
  currency: "INR";
}

export interface Terminal {
  code: string;
  name: string;
  cityId: string;
  cityName: string;
  country: string;
  kind: "airport" | "station" | "bus_stand" | "place";
  utcOffsetMin: number; // local offset of the terminal's city (fixed; no DST in demo data)
}

export interface Segment {
  id: string; // unique per service instance, e.g. "T-JAT-NDLS-1940@2026-11-15"
  serviceId: string;
  mode: Mode;
  operator: string;
  provider: string;
  from: Terminal;
  to: Terminal;
  departAt: string; // ISO with offset
  arriveAt: string;
  fare: Money | null; // null = unknown
  fareKind: "quoted" | "estimated";
  fareLow?: Money; // only for estimates with a defensible range
  fareHigh?: Money;
  fareClass: string;
  source: DataSource;
  fetchedAt: string;
  capability: Capability;
  bookingUrl?: string;
  refundable: boolean | null;
  baggage?: string;
  /** Segments sharing a ticketId are ONE ticket (airline-protected connections). Unset = its own ticket. */
  ticketId?: string;
}

export interface Connection {
  fromSegmentId: string;
  toSegmentId: string;
  waitMinutes: number;
  terminalChange: boolean;
  overnight: boolean;
}

export interface CostComponent {
  segmentId: string;
  label: string;
  kind: "quoted" | "estimated" | "unknown";
  perPerson: number | null; // expected
  low: number | null;
  high: number | null;
}

export interface CostBreakdown {
  currency: "INR";
  components: CostComponent[];
  quotedPerPerson: number;
  estimatedPerPerson: number;
  expectedPerPerson: number;
  lowPerPerson: number;
  highPerPerson: number;
  passengers: number;
  expectedGroup: number;
  lowGroup: number;
  highGroup: number;
  unknownComponents: number;
  confidence: "quoted" | "partial" | "estimated";
  assumptions: string[];
}

export interface Itinerary {
  id: string;
  segments: Segment[]; // includes ground transfers
  connections: Connection[];
  departAt: string;
  arriveAt: string;
  durationMinutes: number;
  transfers: number; // number of changes between non-ground legs
  cost: CostBreakdown;
  flags: string[];
  source: DataSource | "mixed";
  oldestFetchedAt: string;
  stale: boolean;
  inconvenience: number;
}

export const ConstraintsSchema = z.object({
  origin: z.string().min(1).max(80),
  destination: z.string().min(1).max(80),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  returnDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  passengers: z.number().int().min(1).max(9).default(1),
  modes: z.array(z.enum(["flight", "train", "bus"])).min(1).max(3).default(["flight", "train", "bus"]),
  maxBudgetPerPerson: z.number().int().positive().max(10_000_000).optional(), // INR rupees
  arriveBy: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/).optional(), // local IST
  maxTransfers: z.number().int().min(0).max(3).optional(),
  avoidOvernightBuses: z.boolean().default(false),
  avoidOvernightStops: z.boolean().default(false),
  maxLayoverHours: z.number().min(1).max(48).optional(),
  priority: z.enum(["fastest", "cheapest", "bestValue", "convenient"]).default("bestValue"),
});
export type Constraints = z.infer<typeof ConstraintsSchema>;

export interface ProviderStatus {
  providerId: string;
  ok: boolean;
  segments: number;
  ms: number;
  error?: string;
}

export interface CharterOption {
  mode: "private_jet" | "helicopter" | "seaplane";
  fromSite: string;
  toSite: string;
  distanceKm: number;
  note: string;
  link: { label: string; url: string };
}

export interface SearchResult {
  /** Charter-style options. Never priced: no public price feed exists, so the UI shows "price on request". */
  charter?: CharterOption[];
  itineraries: Itinerary[];
  rankings: Record<"fastest" | "cheapest" | "bestValue" | "convenient", string[]>;
  explanations: Record<string, string[]>;
  providers: ProviderStatus[];
  partial: boolean;
  dataLabel: "demo" | "live" | "mixed" | "none";
  generatedAt: string;
  notes: string[];
}
