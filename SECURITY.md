# Security

Security contact: **[OWNER: security@your-domain]** (replace before launch). Report vulnerabilities privately.

## Threat model (summary)

| Threat | Control | Where |
|---|---|---|
| Account takeover / enumeration | Supabase Auth, verified email required for private APIs, generic login/reset messages, min 10-char passwords | `AuthForm`, `requireUser` |
| Broken access control / IDOR | Identity only from verified session; every store read is `(id, userId)`; missing = foreign (identical 404); RLS owner policies | `store.ts`, migration, `api.test.ts` |
| Fare/price tampering | Client never sends prices; server recomputes itinerary, hash-binds quote to user+segments+amount+conditions | `/api/quotes`, `service.ts` |
| Duplicate purchase | Idempotency key unique per user, CAS state transition, no blind retry, reconciliation | `service.ts`, DB unique |
| Fake confirmation | `CONFIRMED` needs provider reference; payment event alone does not confirm; DB CHECK | `service.ts`, SQL |
| Webhook forgery/replay | HMAC-SHA256 over `timestamp.body`, constant-time compare, 5-min window, event-id dedupe | `verifyWebhook`, `provider_events` |
| Scraping / bots / spam | Per-IP + per-user rate limits (Upstash in prod), body-size caps, Turnstile (server-verified) on anonymous search | `rate-limit.ts`, `turnstile.ts` |
| Denial of wallet | LLM only when rules fail, daily per-IP cap, 500-char input, 6 s timeout, kill switch `LLM_ENABLED=false` | `chat/route.ts`, `llm.ts` |
| Prompt injection | Model output is schema-validated constraint patch only; no tools; provider text sanitised | `llm.ts`, `sanitize.ts` |
| XSS / clickjacking / sniffing | React escaping, CSP, X-Frame-Options DENY, nosniff, HSTS, Referrer-Policy, Permissions-Policy | `next.config.ts` |
| CSRF | SameSite cookies (Supabase) + Origin allow-list on state-changing API calls | `sameOriginOk` |
| Open redirect | Redirect targets must be same-site relative paths | `safeRedirectPath` |
| SSRF | No user-supplied URLs fetched; fixed hosts for LLM/Turnstile | `llm.ts`, `turnstile.ts` |
| Secret leakage | Service-role key server-only; `.env*` git-ignored; logs redact sensitive keys; errors generic with request id | `sanitize.ts`, `http.ts` |
| Android | HTTPS only, backup off, system CAs only, system-browser OAuth, allowlisted deep link host/scheme | manifest, `AuthForm` |
| Payment tampering / fake "paid" | Server-owned amount (no amount in the API), status always fetched server-to-server, amount+currency equality, authenticated webhooks that only name a payment, CAS settlement | `payments/service.ts` |
| Place-search abuse | `/api/places` is rate-limited (90/min/IP), query length capped at 80, results are labels only (no coordinates) | `api/places/route.ts` |

## Residual risks / known limitations (be honest)

1. **CSP allows `'unsafe-inline'` scripts** (Next.js inline bootstrap). Adopt a nonce-based proxy to remove it.
2. **In-memory rate limiting** is per-instance unless Upstash is configured; configure it before production.
3. **No durable booking store implemented yet**; do not enable live booking until it exists and is tested.
4. **RLS SQL has not been executed against a live database** in this build; run `supabase/tests/rls_negative.sql` on a staging project.
5. **Account deletion vs. booking retention:** bookings, quotes and payments use `ON DELETE SET NULL`, so deleting the login unlinks the person from retained financial records. Decide your retention period and add a purge job (not included).
6. No admin surface is shipped (intentionally). If added: server-side role checks + MFA, never a client-supplied role.
7. Step-up authentication for high-risk actions is not implemented (documented gap).
8. `x-forwarded-for` is trusted as set by Vercel; behind other proxies, configure accordingly.
9. Dependency audit: production deps 0 known vulnerabilities at build time; 3 moderate findings in the dev-only Capacitor CLI (`uuid` via `xcode`), not shipped in the app.

## Secrets rotation

Rotate in the provider dashboards, then update Vercel env vars and redeploy: Supabase anon/service keys (Settings → API), Google OAuth secret (in Supabase Auth provider), Turnstile secret, Upstash token, LLM key, per-provider webhook secrets (support two secrets during rollover). If a service-role key leaks: rotate immediately, review `auth.users` and booking tables, invalidate sessions.

## Incident response basics

Disable the affected integration (`DISABLED_PROVIDERS`), disable LLM (`LLM_ENABLED=false`), rotate secrets, review structured logs by request id, notify affected users and regulators as the law requires ([OWNER: confirm obligations, e.g. CERT-In 6-hour reporting and DPDP breach notification]), write a post-mortem.

## Backup & recovery

Enable Supabase PITR/daily backups on the production project; test a restore quarterly. Keep provider credentials in the host's secret store and a sealed offline copy of the Android upload keystore + passwords (loss = cannot update the app unless Play App Signing upload-key reset is used).
