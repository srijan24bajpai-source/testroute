import { z } from "zod";
import { handlePaymentWebhook } from "@/lib/payments/service";
import { payDeps } from "@/lib/payments/server";
import { errorJson, guard, json, requestId, toErrorResponse } from "@/lib/security/http";
import { LIMITS } from "@/lib/security/rate-limit";

export const dynamic = "force-dynamic";
export const maxDuration = 30; // seconds (Vercel function limit)

/**
 * PhonePe / PayPal webhooks. Authenticated by the gateway-specific scheme (PhonePe: SHA256(username:password)
 * header; PayPal: verify-webhook-signature). The body only names the payment; the real status is fetched from the gateway.
 */
export async function POST(req: Request, ctx: { params: Promise<{ gateway: string }> }) {
  const rid = requestId();
  try {
    const blocked = await guard(req, LIMITS.webhook);
    if (blocked) return blocked;
    const g = z.enum(["phonepe", "paypal"]).safeParse((await ctx.params).gateway);
    const raw = await req.text();
    if (raw.length > 64 * 1024) return errorJson("PAYLOAD_TOO_LARGE", "Too large.", 413);
    if (!g.success) return errorJson("INVALID_SIGNATURE", "Invalid signature.", 401); // same answer as a bad signature
    const out = await handlePaymentWebhook(payDeps(req), g.data, req.headers, raw);
    return out.status === 200 ? json({ received: true }) : errorJson("INVALID_SIGNATURE", "Invalid signature.", 401);
  } catch (e) {
    return toErrorResponse(e, rid);
  }
}
