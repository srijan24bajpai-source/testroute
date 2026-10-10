import { randomUUID } from "node:crypto";
import { z } from "zod";
import { requireUser } from "@/lib/auth/session";
import { getStore } from "@/lib/booking/store";
import { ConstraintsSchema } from "@/lib/domain/types";
import { errorJson, guard, json, readJson, requestId, toErrorResponse } from "@/lib/security/http";
import { LIMITS } from "@/lib/security/rate-limit";
import { sanitizeText } from "@/lib/security/sanitize";

export const dynamic = "force-dynamic";
const Body = z.object({ title: z.string().min(1).max(100), constraints: ConstraintsSchema });

export async function GET(req: Request) {
  const rid = requestId();
  try {
    const user = await requireUser(req);
    return json({ trips: await getStore().listTrips(user.id) });
  } catch (e) {
    return toErrorResponse(e, rid);
  }
}

export async function POST(req: Request) {
  const rid = requestId();
  try {
    const user = await requireUser(req);
    const blocked = await guard(req, LIMITS.search, user.id);
    if (blocked) return blocked;
    const { title, constraints } = await readJson(req, Body);
    const trip = { id: randomUUID(), userId: user.id, title: sanitizeText(title, 100), constraints: constraints as Record<string, unknown>, createdAt: new Date().toISOString() };
    await getStore().saveTrip(trip);
    return json({ trip }, 201);
  } catch (e) {
    return toErrorResponse(e, rid);
  }
}

export async function DELETE(req: Request) {
  const rid = requestId();
  try {
    const user = await requireUser(req);
    const blocked = await guard(req, LIMITS.search, user.id);
    if (blocked) return blocked;
    const id = new URL(req.url).searchParams.get("id") ?? "";
    if (!z.string().uuid().safeParse(id).success) return errorJson("VALIDATION", "Invalid id.", 400);
    return (await getStore().deleteTrip(id, user.id)) ? json({ deleted: true }) : errorJson("NOT_FOUND", "Trip not found.", 404);
  } catch (e) {
    return toErrorResponse(e, rid);
  }
}
