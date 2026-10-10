# Deploy to Vercel: complete guide

The site is a standard Next.js 16 app. **Build:** `npm run build` (Node 20.9+; Vercel's default Node 24 works). **No `vercel.json` is needed.**
Everything below can be done in the dashboards; no secret ever goes into the repository or into chat.

## 0. What works at each stage

| Stage | You add | You get |
|---|---|---|
| **A. Demo (day one)** | `APP_ORIGIN` only | Worldwide place search, route search and ranking on **clearly labelled demo data**, chat + voice, 3 journey modes, guided manual booking with official links. No accounts, no booking, no payments. |
| **B. Accounts + saved data** | Supabase (4 variables) + SQL | Sign-up/login (email + Google), saved trips, account export/delete, durable storage. |
| **C. Live flight prices** | `DUFFEL_ACCESS_TOKEN`, `DUFFEL_FX_RATES` | Real flight fares replace the demo flights (trains/buses stay demo). Search only. |
| **D. Booking + payments** | A live **booking provider adapter** (not included) **and** PhonePe and/or PayPal credentials | Pay-then-book checkout. **Cannot be switched on by settings alone**: it needs a ticket provider that you have an agreement with. See `AUTOMATED_BOOKING.md`. |

## 1. Deploy (stage A)

**From GitHub (recommended):** push the project (use `git`, not the web uploader, which drops folders and caps at 100 files). In Vercel: *Add New → Project → Import* the repo, framework **Next.js**, leave build settings alone.
**From your computer:** inside the project folder run `npx vercel login`, then `npx vercel --prod`. `.vercelignore` keeps the upload small.

Then add the variable and redeploy once:

| Variable | Value |
|---|---|
| `APP_ORIGIN` | your production address, e.g. `https://airoutepilot.vercel.app` (no trailing slash) |

Check: open `/api/health` → `"ok":true`; search *Kanpur → Pune*. The first request after idle is ~1 s slower while the place data loads.

If *Settings → Deployment Protection* asks visitors to log in, use the main production domain or disable protection for production.

## 2. Accounts and storage (stage B)

1. **Create a Supabase project** (use a separate one for testing).
2. **SQL editor:** paste and run `supabase-setup.sql` (or `supabase/migrations/0001_init.sql`, then `0002_payments.sql`) once. (Optional on a test project: run `supabase/tests/rls_negative.sql` and confirm it ends with "RLS negative tests passed".)
3. **Supabase → Authentication:** enable email confirmations. *URL configuration:* Site URL = your `APP_ORIGIN`; add redirect URL `APP_ORIGIN/auth/callback`. For Google sign-in: create an OAuth client in Google Cloud, paste its id/secret into *Authentication → Providers → Google* (never into Vercel or the repo), and add Supabase's callback URL to the Google client.
4. **Vercel → Settings → Environment Variables** (Production; use separate values for Preview):

| Variable | Notes |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Public by design (protected by row-level security) |
| `SUPABASE_SERVICE_ROLE_KEY` | **Secret.** Server only. Never prefix with `NEXT_PUBLIC_` |
| `STORE_DRIVER` | `supabase` |
| `PASSENGER_DATA_KEY` | 32 random bytes, base64: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`. Losing it only affects traveller names held for minutes during a checkout |

5. Redeploy. `/api/health` should now show `"auth":true`.

Production **refuses** the throwaway in-memory store: without `STORE_DRIVER=supabase`, saved-trip and booking endpoints answer a clear "not enabled yet" (HTTP 503) instead of losing data.

## 3. Recommended hardening (before real users)

- **Upstash Redis** (`UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`): rate limits are otherwise per server instance only.
- **Cloudflare Turnstile** (`TURNSTILE_SECRET_KEY`): bot check on anonymous search.
- **Spend alerts** in Vercel, Supabase and any AI provider. Kill switches: `DISABLED_PROVIDERS`, `LLM_ENABLED=false`, `PAYMENTS_ENABLED` unset.
- Complete the `[OWNER: …]` placeholders in the privacy policy, terms and `src/config/brand.ts`.

## 4. Live flight prices (stage C)

Create a Duffel test token (dashboard → More → Developers → Access tokens) and set `DUFFEL_ACCESS_TOKEN` plus `DUFFEL_FX_RATES`, e.g. `{"USD":85,"EUR":92,"GBP":108}` (rupees per unit; keep it current. Offers in a currency without a rate are skipped). `/api/health` then shows `"liveFares":{"flights":"duffel"}`. The adapter has not been run against Duffel's real API: test with the sandbox first.

## 5. Payment gateways (stage D): where to change things

| To… | Do this |
|---|---|
| Turn payments on/off | `PAYMENTS_ENABLED=true` / unset |
| Choose and order gateways | `PAYMENT_GATEWAYS=phonepe,paypal` (or `paypal,phonepe`, or one only) |
| Configure PhonePe / PayPal | the `PHONEPE_*` / `PAYPAL_*` variables in `.env.example`; webhooks `APP_ORIGIN/api/payments/webhook/phonepe` and `/paypal` |
| Add another gateway (Razorpay, Stripe…) | Implement `PaymentGateway` (`src/lib/payments/types.ts`; copy `phonepe.ts`), add it to `ALL_GATEWAYS` and `getGateway()` in `registry.ts`, and to the `GatewayId` type. The settlement logic (`service.ts`) needs no change |
| Add a ticket provider | Implement `BookingProvider` (`src/lib/providers/types.ts`) and return it from `getBookingProvider()` in `src/lib/booking/providers.ts`; make `liveBookingAvailable()` return true |

Full details, test checklist and the refund gap: `PAYMENTS.md`. **Do not take real money until refunds are automated or you have a manual refund process.**

## 6. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Build: `Couldn't find any pages or app directory` | The `src/` folder is not in the repo (web uploads drop folders). Push with git or `npx vercel --prod` |
| Build fails with TypeScript errors in `tests/` | Pull the latest `tsconfig.json`; tests are type-checked during the build |
| Saved trips / dashboard say "not enabled" (503) | Stage B is incomplete: set `STORE_DRIVER=supabase`, Supabase variables, `PASSENGER_DATA_KEY` |
| Sign-in redirects fail | Site URL and redirect URL in Supabase must exactly equal `APP_ORIGIN` / `APP_ORIGIN/auth/callback` |
| `/api/checkout` → `BOOKING_NOT_AVAILABLE` | Expected until a live booking provider exists (stage D) |
| Searches slow right after idle | Cold start loads ~4 MB place data once per instance |
