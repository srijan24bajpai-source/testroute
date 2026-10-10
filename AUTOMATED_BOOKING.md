# Mode 3: "Plan it for me" / automated booking and UPI: what exists and what is needed

## What works today
- Mode 3 collects start (typed or "use my location"), destination, date, travellers and **total budget**, then selects the best itinerary that fits (or the cheapest and the shortfall if none fits).
- It then says plainly that automated booking is off and hands the exact plan to the guided manual checklist (Mode 2).
- **No ticket is bought, no payment is requested, nothing is simulated.** `/api/health` reports `features.liveBooking: false` until a real adapter is registered.

## What "fully automated, user only pays by UPI" requires (none of this exists yet)

| Need | Why | Owner action |
|---|---|---|
| Authorised ticketing access per mode: airline/consolidator/NDC (flights), IRCTC partner or agent status (trains), operator/aggregator API (buses) | Booking must go through official channels. We deliberately do **not** drive other companies' websites with bots or scripts (terms violations, fragile, and unlawful for IRCTC). | Apply to each provider; see `API_INTEGRATIONS.md` |
| Legal entity and licences | Taking money and booking on someone's behalf makes you a travel agent/intermediary. Payment-collection, tax (GST), consumer-protection and data rules apply. | Take advice from a lawyer/CA. I have not verified current Indian rules. |
| Payment provider with UPI and **signed webhooks** (e.g. a payment aggregator) | "User pays manually and tells us" is unverifiable: a screenshot or UTR typed by the user proves nothing. Payment must be confirmed server-side by webhook. | Open a merchant account; enter keys in the host dashboard only |
| Durable store, reconciliation job, refunds flow | Already designed (`ARCHITECTURE.md`, `BUILD_STATUS.md`), not yet implemented | Engineering |
| Support/admin tooling with MFA | Failed or partial bookings need a human | Engineering + staffing |

## The hard problem: multi-leg atomicity
A journey is several independent tickets. Any leg can sell out or fail after others succeed. A safe design must:
1. Re-price every leg right before checkout and show one total for explicit confirmation.
2. Authorise or hold payment first, then book the **hardest-to-get leg first** (usually the train), then the rest.
3. If a later leg fails: automatically cancel/refund earlier legs where the provider allows, or offer alternatives; never leave the user with a half-journey without telling them and without a stated refund path.
4. Mark a booking `CONFIRMED` only with provider references (already enforced in code and DB constraint).

## Recommended build order
1. One provider, one mode, sandbox credentials, contract tests.
2. Payment aggregator in test mode with webhook verification.
3. Single-leg real bookings behind a feature flag for a small group.
4. Multi-leg orchestration with the failure policy above.
5. Only then switch `liveBooking` on in `/api/health` and the UI.
