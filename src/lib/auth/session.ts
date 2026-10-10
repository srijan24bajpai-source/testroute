import { serverClient, supabaseConfigured } from "../supabase/server";

export interface SessionUser {
  id: string;
  emailVerified: boolean;
}

export class AuthError extends Error {
  constructor(public status: 401 | 403 | 503, message: string) {
    super(message);
  }
}

/** Dev-only auth shim: refused in production regardless of env flags. */
export function devAuthAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV !== "production" && env.ALLOW_DEV_AUTH === "true";
}

/**
 * Server-side authentication for every private endpoint. Never trusts client-submitted roles
 * or user ids; the identity always comes from the verified Supabase session (getUser() calls
 * the Auth server, it does not just decode the cookie).
 */
export async function requireUser(req: Request): Promise<SessionUser> {
  if (devAuthAllowed()) {
    const id = req.headers.get("x-dev-user-id");
    if (id && /^[a-zA-Z0-9_-]{3,64}$/.test(id)) return { id, emailVerified: true };
  }
  if (!supabaseConfigured()) {
    throw new AuthError(devAuthAllowed() ? 401 : 503, devAuthAllowed() ? "Authentication required." : "Authentication is not configured on this deployment.");
  }
  const supabase = await serverClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) throw new AuthError(401, "Authentication required.");
  if (!data.user.email_confirmed_at) throw new AuthError(403, "Please verify your email address first.");
  return { id: data.user.id, emailVerified: true };
}
