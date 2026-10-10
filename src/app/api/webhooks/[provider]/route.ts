import { z } from "zod";
import { applyProviderEvent, verifyWebhook } from "@/lib/booking/service";
import { getBookingProvider } from "@/lib/booking/providers";
import { getStore } from "@/lib/booking/store";
import { errorJson, guard, json, requestId, toErrorResponse } from "@/lib/security/http";
import { LIMITS } from "@/lib/security/rate-limit";

export const dynamic = "force-dynamic";
const Event = z.object({
  id: z.string().min(1).max(100),
  type: z.enum(["payment.succeeded", "payment.failed", "booking.confirmed", "booking.failed", "booking.cancelled"]),
  externalRef: z.string().min(1).max(100),
  bookingRef: z.string().min(1).max(100).optional(),
});

/** Secrets are read per provider from WEBHOOK_SECRET_<PROVIDER> (upper-case, non-alphanumerics become underscores). */
export async function POST(req: Request, ctx: { params: Promise<{ provider: string }> }) {
  const rid = requestId();
  try {
    const { provider } = await ctx.params;
    const blocked = await guard(req, LIMITS.webhook);
    if (blocked) return blocked;
    const secret = process.env[`WEBHOOK_SECRET_${provider.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`];
    const raw = await req.text();
    if (raw.length > 64 * 1024) return errorJson("PAYLOAD_TOO_LARGE", "Too large.", 413);
    // Unknown provider or missing secret is indistinguishable from a bad signature.
    if (!secret || !verifyWebhook(secret, req.headers.get("x-webhook-timestamp") ?? "", req.headers.get("x-webhook-signature") ?? "", raw)) {
      return errorJson("INVALID_SIGNATURE", "Invalid signature.", 401);
    }
    const ev = Event.parse(JSON.parse(raw));
    const out = await applyProviderEvent({ store: getStore(), getBookingProvider }, provider, ev);
    return json({ received: true, ...out });
  } catch (e) {
    return toErrorResponse(e, rid);
  }
}
