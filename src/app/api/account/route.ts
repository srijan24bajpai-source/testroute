import { requireUser } from "@/lib/auth/session";
import { getStore } from "@/lib/booking/store";
import { guard, json, requestId, toErrorResponse, errorJson } from "@/lib/security/http";
import { LIMITS } from "@/lib/security/rate-limit";
import { adminClient, supabaseConfigured } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/** Data export (access request). */
export async function GET(req: Request) {
  const rid = requestId();
  try {
    const user = await requireUser(req);
    const blocked = await guard(req, LIMITS.account, user.id);
    if (blocked) return blocked;
    return json({ exportedAt: new Date().toISOString(), userId: user.id, ...(await getStore().exportUser(user.id)) });
  } catch (e) {
    return toErrorResponse(e, rid);
  }
}

/**
 * Account deletion. Saved trips/quotes are erased; booking ledger rows are retained in
 * minimal form where transaction/statutory record-keeping requires it (see PRIVACY_DATA_MAP.md).
 */
export async function DELETE(req: Request) {
  const rid = requestId();
  try {
    const user = await requireUser(req);
    const blocked = await guard(req, LIMITS.account, user.id);
    if (blocked) return blocked;
    if (new URL(req.url).searchParams.get("confirm") !== "DELETE") return errorJson("CONFIRMATION_REQUIRED", "Add ?confirm=DELETE to confirm account deletion.", 400);
    const summary = await getStore().eraseUser(user.id);
    if (supabaseConfigured() && process.env.SUPABASE_SERVICE_ROLE_KEY) {
      const { error } = await adminClient().auth.admin.deleteUser(user.id);
      if (error) return errorJson("DELETE_FAILED", "Your data was erased but the login could not be removed. Contact support.", 502);
    }
    return json({ deleted: true, ...summary });
  } catch (e) {
    return toErrorResponse(e, rid);
  }
}
