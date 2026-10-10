import { NextResponse } from "next/server";
import { safeRedirectPath } from "@/lib/security/sanitize";
import { serverClient, supabaseConfigured } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/** OAuth/email-link return (PKCE code exchange). Redirect target is restricted to same-site paths. */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const next = safeRedirectPath(url.searchParams.get("next"));
  const origin = process.env.APP_ORIGIN ?? url.origin;
  const code = url.searchParams.get("code");
  if (!supabaseConfigured() || !code) return NextResponse.redirect(`${origin}/login?error=auth`);
  const supabase = await serverClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) return NextResponse.redirect(`${origin}/login?error=auth`);
  return NextResponse.redirect(`${origin}${next}`);
}
