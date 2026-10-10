# RoutePilot AI

Conversational multi-modal journey planner for India (trains + flights + buses in one route), as a Next.js website packaged for Android with Capacitor. Brand is configurable in `src/config/brand.ts`.

> **Honest status:** with no provider credentials the app runs on clearly labelled **demo data**. It never issues tickets or charges money in that mode. Read `BUILD_STATUS.md` before launching.

## Quick start (local)

```bash
node -v            # >= 20.9 (built with 24)
npm install
npm test           # 211 tests
npm run typecheck
npm run dev        # http://localhost:3000
```

Production build: `npm run build && npm start`.

No environment variables are needed to try the demo (search, ranking, budget, chat). Accounts need Supabase (see `.env.example`). For local testing of private endpoints you may set `ALLOW_DEV_AUTH=true` (ignored in production) and send `x-dev-user-id: some-id`.

Try: *Kanpur → Pune*, *Rajasthan → Kerala*, *Reykjavik → Sydney*, *Lucknow → Goa* (any city, state or airport in the world; codes such as LKO, GOI, LHR work too), or chat: `Jammu to Kanyakumari on 20 Dec for 2, under ₹8,000, avoid overnight buses`, then `show me the cheapest`, `arrive before 9 AM`, `book option two`.

## Layout

| Path | What |
|---|---|
| `src/lib/domain` | types (zod), money (integer paise), time (IST), place gazetteer |
| `src/lib/providers` | provider interfaces, demo provider, ground-transfer estimator, registry |
| `src/lib/search` | route builder (connections, buffers), budget, ranking, orchestration |
| `src/lib/agent` | rule-based intent parser, optional LLM extractor (validated, no tools) |
| `src/lib/booking` | state machine, store interface, quote/confirm/reconcile/cancel/webhook logic |
| `src/lib/security` | rate limiting, Turnstile, sanitising/redaction, HTTP guards |
| `src/app/api` | route handlers (all inputs zod-validated) |
| `supabase/migrations` | schema + RLS |
| `android/` | Capacitor Android project |
| `tests/` | vitest suites |

Deploying: see `DEPLOY_VERCEL.md` (stages A to D, every environment variable, troubleshooting).

Rebuild place data: `node scripts/build-places.mjs <folder with the GeoNames + OurAirports files>` (see the script header).

Docs: `PAYMENTS.md`, `AUTOMATED_BOOKING.md`, `ARCHITECTURE.md`, `SECURITY.md`, `PRIVACY_DATA_MAP.md`, `API_INTEGRATIONS.md`, `DEPLOY_VERCEL.md`, `ANDROID_RELEASE.md`, `PLAY_STORE_LISTING.md`, `BUILD_STATUS.md`.
