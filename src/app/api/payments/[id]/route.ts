import { z } from "zod";
import { requireUser } from "@/lib/auth/session";
import { paymentStatus } from "@/lib/payments/service";
import { payDeps } from "@/lib/payments/server";
import { errorJson, guard, json, requestId, toErrorResponse } from "@/lib/security/http";
import { LIMITS } from "@/lib/security/rate-limit";

export const dynamic = "force-dynamic";
export const maxDuration = 30; // seconds (Vercel function limit)

/** Poll target for the return page. Asks the gateway server-to-server; the browser's redirect proves nothing. */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const rid = requestId();
  try {
    const user = await requireUser(req);
    const blocked = await guard(req, LIMITS.payment, user.id);
    if (blocked) return blocked;
    const { id } = await ctx.params;
    if (!z.string().uuid().safeParse(id).success) return errorJson("NOT_FOUND", "Payment not found.", 404);
    return json({ payment: await paymentStatus(payDeps(req), user.id, id) });
  } catch (e) {
    return toErrorResponse(e, rid);
  }
}
