import { NextResponse } from "next/server";
import { ZodError, type ZodType } from "zod";
import { AuthError } from "../auth/session";
import { BookingError } from "../booking/service";
import { IllegalTransition } from "../booking/state";
import { PlaceError } from "../search/plan";
import { clientIp, rateLimit, type Limit } from "./rate-limit";
import { log } from "./sanitize";

export const MAX_BODY_BYTES = 32 * 1024;

export function json(data: unknown, status = 200, headers: Record<string, string> = {}) {
  return NextResponse.json(data, { status, headers: { "cache-control": "no-store", ...headers } });
}

export function errorJson(code: string, message: string, status: number, extra: Record<string, unknown> = {}) {
  return json({ error: { code, message, ...extra } }, status);
}

/** Enforces same-origin for state-changing requests (CSRF defence in depth on top of SameSite cookies). */
export function sameOriginOk(req: Request): boolean {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return true;
  const origin = req.headers.get("origin");
  if (!origin) return !process.env.APP_ORIGIN; // non-browser callers carry no cookies
  const allowed = new Set([new URL(req.url).origin, process.env.APP_ORIGIN, ...(process.env.ALLOWED_ORIGINS ?? "").split(",")].filter(Boolean));
  return allowed.has(origin);
}

export async function readJson<T>(req: Request, schema: ZodType<T>): Promise<T> {
  const len = Number(req.headers.get("content-length") ?? "0");
  if (len > MAX_BODY_BYTES) throw new BookingError("PAYLOAD_TOO_LARGE", "Request body too large.", 413);
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) throw new BookingError("PAYLOAD_TOO_LARGE", "Request body too large.", 413);
  let raw: unknown;
  try {
    raw = JSON.parse(text || "{}");
  } catch {
    throw new BookingError("INVALID_JSON", "Request body must be valid JSON.", 400);
  }
  return schema.parse(raw);
}

export async function guard(req: Request, limit: Limit, userId?: string): Promise<Response | null> {
  if (!sameOriginOk(req)) return errorJson("BAD_ORIGIN", "Cross-origin request rejected.", 403);
  const ip = clientIp(req.headers);
  const byIp = await rateLimit(limit, `ip:${ip}`);
  const byUser = userId ? await rateLimit(limit, `u:${userId}`) : null;
  const blocked = !byIp.allowed ? byIp : byUser && !byUser.allowed ? byUser : null;
  if (blocked) return json({ error: { code: "RATE_LIMITED", message: "Too many requests. Please slow down." } }, 429, { "retry-after": String(blocked.retryAfterSec) });
  return null;
}

/** Maps domain errors to safe responses. Unknown errors never leak details. */
export function toErrorResponse(e: unknown, requestId: string): Response {
  if (e instanceof ZodError) return errorJson("VALIDATION", "Invalid request.", 400, { issues: e.issues.slice(0, 5).map((i) => ({ path: i.path.join("."), message: i.message })) });
  if (e instanceof AuthError) return errorJson(e.status === 401 ? "UNAUTHENTICATED" : e.status === 403 ? "FORBIDDEN" : "AUTH_UNAVAILABLE", e.message, e.status);
  if (e instanceof PlaceError) return errorJson("UNSUPPORTED_PLACE", e.message, 422, { field: e.field });
  if (e instanceof BookingError) return errorJson(e.code, e.message, e.httpStatus, e.extra);
  if (e instanceof IllegalTransition) return errorJson("ILLEGAL_STATE", "That action is not allowed in the booking's current state.", 409);
  log("error", "unhandled", { requestId, message: e instanceof Error ? e.message : "unknown" });
  return errorJson("INTERNAL", "Something went wrong. Please try again.", 500, { requestId });
}

export function requestId(): string {
  return crypto.randomUUID();
}
