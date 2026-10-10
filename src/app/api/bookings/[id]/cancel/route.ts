import { requireUser } from "@/lib/auth/session";
import { requestCancel } from "@/lib/booking/service";
import { getBookingProvider } from "@/lib/booking/providers";
import { getStore } from "@/lib/booking/store";
import { guard, json, requestId, toErrorResponse } from "@/lib/security/http";
import { LIMITS } from "@/lib/security/rate-limit";

export const dynamic = "force-dynamic";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const rid = requestId();
  try {
    const user = await requireUser(req);
    const blocked = await guard(req, LIMITS.cancel, user.id);
    if (blocked) return blocked;
    const { id } = await ctx.params;
    return json(await requestCancel({ store: getStore(), getBookingProvider }, user.id, id));
  } catch (e) {
    return toErrorResponse(e, rid);
  }
}
