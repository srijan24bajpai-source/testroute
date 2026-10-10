import { z } from "zod";
import { searchPlaces } from "@/lib/geo/directory";
import { errorJson, guard, json, requestId, toErrorResponse } from "@/lib/security/http";
import { LIMITS } from "@/lib/security/rate-limit";

export const dynamic = "force-dynamic";

const Query = z.object({ q: z.string().trim().min(2).max(80), limit: z.coerce.number().int().min(1).max(10).default(8) });

/** Autocomplete over every city, state/region and airport we know. Returns labels only (no coordinates). */
export async function GET(req: Request) {
  const rid = requestId();
  try {
    const blocked = await guard(req, LIMITS.places);
    if (blocked) return blocked;
    const url = new URL(req.url);
    const parsed = Query.safeParse({ q: url.searchParams.get("q") ?? "", limit: url.searchParams.get("limit") ?? undefined });
    if (!parsed.success) return errorJson("VALIDATION", "Type at least 2 letters.", 400);
    const places = searchPlaces(parsed.data.q, parsed.data.limit).map((p) => ({ id: p.id, label: p.label, kind: p.kind }));
    return json({ places }, 200, { "cache-control": "private, max-age=60" });
  } catch (e) {
    return toErrorResponse(e, rid);
  }
}
