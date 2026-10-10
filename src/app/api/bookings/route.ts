import { z } from "zod";
import { requireUser } from "@/lib/auth/session";
import { confirmBooking } from "@/lib/booking/service";
import { getBookingProvider } from "@/lib/booking/providers";
import { getStore } from "@/lib/booking/store";
import { guard, json, readJson, requestId, toErrorResponse } from "@/lib/security/http";
import { LIMITS } from "@/lib/security/rate-limit";

export const dynamic = "force-dynamic";

const Body = z.object({
  quoteId: z.string().uuid(),
  quoteHash: z.string().length(64),
  acknowledgedTotal: z.number().int().positive(),
  acceptedConditions: z.literal(true),
  idempotencyKey: z.string().min(16).max(80).regex(/^[A-Za-z0-9_-]+$/),
  passengers: z.array(z.object({ fullName: z.string().min(2).max(80), age: z.number().int().min(0).max(120) })).min(1).max(9),
});

export async function GET(req: Request) {
  const rid = requestId();
  try {
    const user = await requireUser(req);
    return json({ bookings: await getStore().listBookings(user.id) });
  } catch (e) {
    return toErrorResponse(e, rid);
  }
}

export async function POST(req: Request) {
  const rid = requestId();
  try {
    const user = await requireUser(req);
    const blocked = await guard(req, LIMITS.booking, user.id);
    if (blocked) return blocked;
    const input = await readJson(req, Body);
    const out = await confirmBooking({ store: getStore(), getBookingProvider }, user.id, input);
    if (out.kind === "requote") return json({ status: "QUOTE_REFRESH_REQUIRED", message: "The price or availability changed. Review the new quote before confirming.", quote: out.quote }, 409);
    return json({ booking: out.booking, replay: out.replay }, out.replay ? 200 : 201);
  } catch (e) {
    return toErrorResponse(e, rid);
  }
}
