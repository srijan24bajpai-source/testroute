"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { authConfigured, browserClient } from "@/lib/supabase/browser";
import { brand } from "@/config/brand";

type Kind = "login" | "signup" | "reset";

async function isNative(): Promise<boolean> {
  try {
    const { Capacitor } = await import("@capacitor/core");
    return Capacitor.isNativePlatform();
  } catch {
    return false;
  }
}

export function AuthForm({ kind }: { kind: Kind }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const configured = authConfigured();

  // Native (Android) OAuth returns via a verified deep link; exchange the PKCE code here.
  useEffect(() => {
    if (!configured) return;
    let remove: (() => void) | undefined;
    (async () => {
      if (!(await isNative())) return;
      const { App } = await import("@capacitor/app");
      const { Browser } = await import("@capacitor/browser");
      const h = await App.addListener("appUrlOpen", async ({ url }) => {
        const u = new URL(url);
        if (u.protocol !== `${brand.appScheme}:` || u.host !== "auth") return; // allowlisted callback only
        const code = u.searchParams.get("code");
        await Browser.close();
        if (code) {
          const { error } = await browserClient().auth.exchangeCodeForSession(code);
          if (!error) window.location.assign("/dashboard");
          else setMsg({ ok: false, text: "Sign-in failed. Please try again." });
        }
      });
      remove = () => void h.remove();
    })();
    return () => remove?.();
  }, [configured]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!configured) return;
    setBusy(true);
    setMsg(null);
    const sb = browserClient();
    const origin = window.location.origin;
    try {
      if (kind === "login") {
        const { error } = await sb.auth.signInWithPassword({ email, password });
        // Generic message: do not reveal whether the account exists.
        if (error) setMsg({ ok: false, text: "Incorrect email or password, or the email is not verified yet." });
        else window.location.assign("/dashboard");
      } else if (kind === "signup") {
        const { error } = await sb.auth.signUp({ email, password, options: { emailRedirectTo: `${origin}/auth/callback?next=/dashboard` } });
        setMsg(error && /password/i.test(error.message) ? { ok: false, text: error.message } : { ok: true, text: "If this email can be registered, a verification link is on its way. Please check your inbox." });
      } else {
        await sb.auth.resetPasswordForEmail(email, { redirectTo: `${origin}/auth/callback?next=/account` });
        setMsg({ ok: true, text: "If an account exists for that email, a reset link has been sent." });
      }
    } finally {
      setBusy(false);
    }
  }

  async function google() {
    if (!configured) return;
    const sb = browserClient();
    if (await isNative()) {
      const { data } = await sb.auth.signInWithOAuth({ provider: "google", options: { redirectTo: `${brand.appScheme}://auth/callback`, skipBrowserRedirect: true } });
      if (data?.url) {
        const { Browser } = await import("@capacitor/browser");
        await Browser.open({ url: data.url }); // system browser: Google blocks OAuth in embedded webviews
      }
    } else {
      await sb.auth.signInWithOAuth({ provider: "google", options: { redirectTo: `${window.location.origin}/auth/callback?next=/dashboard` } });
    }
  }

  const title = kind === "login" ? "Sign in" : kind === "signup" ? "Create account" : "Reset password";
  return (
    <div className="card" style={{ maxWidth: 420, margin: "24px auto" }}>
      <h1>{title}</h1>
      {!configured && <div className="banner">Accounts are not configured on this deployment (Supabase environment variables are missing). Searching still works without an account.</div>}
      <form onSubmit={submit}>
        <label htmlFor="email">Email</label>
        <input id="email" type="email" autoComplete="email" required maxLength={254} value={email} onChange={(e) => setEmail(e.target.value)} disabled={!configured} />
        {kind !== "reset" && (
          <>
            <label htmlFor="pw" style={{ marginTop: 8 }}>Password</label>
            <input id="pw" type="password" autoComplete={kind === "login" ? "current-password" : "new-password"} required minLength={10} maxLength={128} value={password} onChange={(e) => setPassword(e.target.value)} disabled={!configured} />
            {kind === "signup" && <p className="muted">At least 10 characters.</p>}
          </>
        )}
        <button className="primary" type="submit" disabled={!configured || busy} style={{ marginTop: 12, width: "100%" }}>{busy ? "Please wait…" : title}</button>
      </form>
      {kind !== "reset" && <button type="button" onClick={google} disabled={!configured} style={{ marginTop: 8, width: "100%" }}>Continue with Google</button>}
      {msg && <p role="status" className={msg.ok ? "" : "err"}>{msg.text}</p>}
      <p className="muted">
        {kind !== "login" && <><Link href="/login">Sign in</Link> · </>}
        {kind !== "signup" && <><Link href="/signup">Create account</Link> · </>}
        {kind !== "reset" && <Link href="/reset">Forgot password?</Link>}
      </p>
    </div>
  );
}
