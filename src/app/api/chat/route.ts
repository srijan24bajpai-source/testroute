import { z } from "zod";
import { ConstraintsSchema, type Constraints } from "@/lib/domain/types";
import { extractIntent, followUpQuestion, mergeConstraints, missingFields, todayIst } from "@/lib/agent/intent";
import { llmExtract } from "@/lib/agent/llm";
import { guard, json, readJson, requestId, toErrorResponse } from "@/lib/security/http";
import { LIMITS, clientIp, rateLimit } from "@/lib/security/rate-limit";

export const dynamic = "force-dynamic";
const Body = z.object({
  message: z.string().min(1).max(500),
  constraints: ConstraintsSchema.partial().optional(),
});

export async function POST(req: Request) {
  const rid = requestId();
  try {
    const blocked = await guard(req, LIMITS.chat);
    if (blocked) return blocked;
    const { message, constraints } = await readJson(req, Body);
    const now = new Date();
    const intent = extractIntent(message, now, constraints);
    let patch = intent.patch;
    // Optional LLM assist, only if rules found nothing, and under a daily per-IP cost cap.
    if (Object.keys(patch).length === 0 && (await rateLimit(LIMITS.llmDaily, clientIp(req.headers))).allowed) {
      const viaLlm = await llmExtract(message, todayIst(now));
      if (viaLlm) patch = viaLlm;
    }
    const merged = mergeConstraints(constraints as Partial<Constraints> | undefined, patch);
    const missing = missingFields(merged);
    const question = followUpQuestion(missing, intent.unknownPlaces);
    const ready = missing.length === 0 && ConstraintsSchema.safeParse(merged).success;
    return json({
      constraints: merged,
      missing,
      reply: question || (ready ? "Got it. Review the summary and I'll search." : "Tell me a bit more about your trip."),
      action: ready ? intent.action : { type: "none" },
      ready,
    });
  } catch (e) {
    return toErrorResponse(e, rid);
  }
}
