import { requireUser } from "@/lib/auth/session";
import { getStore } from "@/lib/booking/store";
import { errorJson, json, requestId, toErrorResponse } from "@/lib/security/http";

export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const rid = requestId();
  try {
    const user = await requireUser(req);
    const { id } = await ctx.params;
    const b = await getStore().getBooking(id, user.id);
    // Same response for "missing" and "someone else's": no existence oracle.
    if (!b) return errorJson("NOT_FOUND", "Booking not found.", 404);
    return json({ booking: b });
  } catch (e) {
    return toErrorResponse(e, rid);
  }
}
