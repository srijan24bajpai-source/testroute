import { z } from "zod";
import { ConstraintsSchema } from "@/lib/domain/types";
import { guard, json, readJson, requestId, toErrorResponse, errorJson } from "@/lib/security/http";
import { LIMITS, clientIp } from "@/lib/security/rate-limit";
import { verifyTurnstile } from "@/lib/security/turnstile";
import { runSearch } from "@/lib/search/server";

export const dynamic = "force-dynamic";
export const maxDuration = 30; // seconds (Vercel function limit)
const Body = z.object({ constraints: ConstraintsSchema, turnstileToken: z.string().max(2048).optional() });

export async function POST(req: Request) {
  const rid = requestId();
  try {
    const blocked = await guard(req, LIMITS.search);
    if (blocked) return blocked;
    const { constraints, turnstileToken } = await readJson(req, Body);
    if (!(await verifyTurnstile(turnstileToken, clientIp(req.headers)))) return errorJson("BOT_CHECK_FAILED", "Bot check failed. Please retry.", 403);
    return json(await runSearch(constraints));
  } catch (e) {
    return toErrorResponse(e, rid);
  }
}
