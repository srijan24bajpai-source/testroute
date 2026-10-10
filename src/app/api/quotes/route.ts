import { z } from "zod";
import { requireUser } from "@/lib/auth/session";
import { createQuote } from "@/lib/booking/service";
import { getBookingProvider } from "@/lib/booking/providers";
import { getStore } from "@/lib/booking/store";
import { ConstraintsSchema } from "@/lib/domain/types";
import { guard, json, readJson, requestId, toErrorResponse, errorJson } from "@/lib/security/http";
import { LIMITS } from "@/lib/security/rate-limit";
import { runSearch } from "@/lib/search/server";

export const dynamic = "force-dynamic";
export const maxDuration = 30; // seconds (Vercel function limit)
const Body = z.object({ constraints: ConstraintsSchema, itineraryId: z.string().min(1).max(600) });

/** Server recomputes the itinerary from provider data: the client can never supply a price or route. */
export async function POST(req: Request) {
  const rid = requestId();
  try {
    const user = await requireUser(req);
    const blocked = await guard(req, LIMITS.quote, user.id);
    if (blocked) return blocked;
    const { constraints, itineraryId } = await readJson(req, Body);
    const result = await runSearch(constraints);
    const it = result.itineraries.find((i) => i.id === itineraryId);
    if (!it) return errorJson("ITINERARY_UNAVAILABLE", "That itinerary is no longer available. Please search again.", 409);
    const quote = await createQuote({ store: getStore(), getBookingProvider }, user.id, it);
    return json({ quote: { ...quote, bookable: quote.capability === "QUOTE_AND_BOOK" || quote.capability === "CANCEL_SUPPORTED" } });
  } catch (e) {
    return toErrorResponse(e, rid);
  }
}
