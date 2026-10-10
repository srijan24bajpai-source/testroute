# Architecture

## Decisions

- **One product, one codebase:** Next.js (App Router, TypeScript) web app. Android is a **Capacitor** shell that loads the deployed site (`server.url`). Reason: auth, search and booking need server-side routes that cannot be statically exported; a shell avoids maintaining a second (React Native) app and keeps cookies/session logic identical. Trade-off: the app needs network; an offline fallback page is bundled (`cap-www/`). Google Play policy risk: a pure website wrapper can be rejected as "minimal functionality", so ship native-feeling value (deep links, system-browser OAuth, account deletion) and review Play's current policy before submitting.
- **Deterministic core, LLM at the edge:** routes, prices, ranking, permissions, booking state are plain TypeScript. The LLM (optional) can only propose a validated constraint patch from chat text. It has no tools, no data access, and sees no passenger data.
- **Money** is integer paise everywhere; quoted and estimated amounts are tracked separately.
- **Time** is stored as ISO strings with explicit offsets (demo data is IST); durations come from epoch differences.

## Layers

1. UI (`src/components`, `src/app/*`)
2. Auth/session + authorization (`src/lib/auth`, `src/lib/supabase`): identity always from the server-verified Supabase session; RLS as defence in depth.
3. Travel domain (`src/lib/domain`, `src/lib/search`): normalised `Segment` → `Itinerary`, connection logic, ranking, budget.
4. Provider adapters (`src/lib/providers`): `SegmentProvider` (search) and `BookingProvider` (refresh quote / book / lookup / cancel). Capability matrix: `SEARCH_ONLY | QUOTE_AND_BOOK | CANCEL_SUPPORTED | DEMO_ONLY`.
5. Booking orchestration (`src/lib/booking`): quote → hash-bound confirmation → CAS state transitions → provider call → reconcile.
6. Persistence/audit: `Store` interface; migrations in `supabase/migrations`.

## Search algorithm

Segments for all (hub × hub) city pairs over 5 days are fetched concurrently per provider (timeout, one safe retry, circuit breaker). A DFS builds chains ≤ 4 legs from the origin city: no revisited cities; each join needs `deplane(prev) + boarding(next)` minutes (config `searchConfig`), plus an estimated ground transfer when terminals differ within a city; layovers ≤ 20 h (or user limit). Filters (modes, budget, arrive-by, max changes, overnight bus/stop avoidance) apply to complete itineraries. Results are deduplicated by segment-id sequence.

Ranking: *fastest* (duration), *cheapest* (expected per-person price), *best value* (weighted min–max score: 0.35 price + 0.35 time + 0.10 changes + 0.20 inconvenience), *most convenient* (inconvenience, changes, time). Inconvenience counts overnight waits, overnight buses, 00:00–05:00 departures, terminal changes and tight buffers. Explanations are generated from the same numbers (percentiles), not by an LLM.

## Booking safety

`confirmBooking` checks, in order: idempotent replay → quote ownership/expiry → quote hash → exact acknowledged amount → conditions accepted → passenger count → provider capability → insert (unique per user+key) → provider re-price (mismatch ⇒ `QUOTE_REFRESH_REQUIRED` + new quote, no purchase) → compare-and-set to `BOOKING_IN_PROGRESS` → provider call. Throw/timeout ⇒ `RECONCILIATION_REQUIRED` (never retried; resolved via `lookup`). `CONFIRMED` requires a provider reference (also enforced by a DB CHECK). Passenger names are passed through, not stored.

## Known architectural gaps

- Durable `Store`: `SupabaseStore` exists and is emulator-tested but unproven on a live database. Production refuses the in-memory store.
- No live provider adapters (needs commercial access; see `API_INTEGRATIONS.md`).
- Search fan-out is sized for the demo network; real providers need origin-destination queries and caching.
