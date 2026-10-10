import { z } from "zod";
import { requireUser } from "@/lib/auth/session";
import { startCheckout } from "@/lib/payments/service";
import { payDeps } from "@/lib/payments/server";
import { guard, json, readJson, requestId, toErrorResponse } from "@/lib/security/http";
import { LIMITS } from "@/lib/security/rate-limit";

export const dynamic = "force-dynamic";
export const maxDuration = 30; // seconds (Vercel function limit)

// NOTE: there is deliberately no amount field. The server charges the quote's total and nothing else.
const Body = z.object({
  gateway: z.enum(["phonepe", "paypal"]),
  quoteId: z.string().uuid(),
  quoteHash: z.string().length(64),
  acknowledgedTotal: z.number().int().positive(),
  acceptedConditions: z.literal(true),
  idempotencyKey: z.string().min(16).max(80).regex(/^[A-Za-z0-9_-]+$/),
  passengers: z.array(z.object({ fullName: z.string().min(2).max(80), age: z.number().int().min(0).max(120) })).min(1).max(9),
});

export async function POST(req: Request) {
  const rid = requestId();
  try {
    const user = await requireUser(req);
    const blocked = await guard(req, LIMITS.booking, user.id);
    if (blocked) return blocked;
    const { gateway, ...input } = await readJson(req, Body);
    const out = await startCheckout(payDeps(req), user.id, input, gateway);
    if (out.kind === "requote") {
      return json({ status: "QUOTE_REFRESH_REQUIRED", message: "The price changed before payment. Review the new quote. Nothing was charged.", quote: out.quote }, 409);
    }
    if (out.kind === "existing") {
      return json({ status: out.payment?.status ?? "NONE", paymentId: out.payment?.id ?? null, redirectUrl: out.payment?.status === "PENDING" ? out.payment.redirectUrl : null, replay: true });
    }
    return json({ paymentId: out.payment.id, redirectUrl: out.redirectUrl, disclosure: out.disclosure, gateway, chargedMinor: out.payment.chargedMinor, chargedCurrency: out.payment.chargedCurrency }, 201);
  } catch (e) {
    return toErrorResponse(e, rid);
  }
}
