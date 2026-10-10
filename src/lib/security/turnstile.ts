/**
 * Cloudflare Turnstile server-side verification. If TURNSTILE_SECRET_KEY is unset the check is
 * skipped (dev); in production set it, and the sensitive anonymous endpoints enforce it.
 */
export function turnstileRequired(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.TURNSTILE_SECRET_KEY);
}

export async function verifyTurnstile(token: string | null | undefined, ip: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  if (!turnstileRequired(env)) return true;
  if (!token || token.length > 2048) return false;
  try {
    const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ secret: env.TURNSTILE_SECRET_KEY!, response: token, remoteip: ip }),
      signal: AbortSignal.timeout(4000),
    });
    const data = (await res.json()) as { success?: boolean };
    return data.success === true;
  } catch {
    return false; // fail closed
  }
}
