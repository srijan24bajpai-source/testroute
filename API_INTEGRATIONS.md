# API integrations

**Status: no live provider is integrated.** Only demo adapters exist. This page records what the research session found (web search, October 2026); every point must be re-verified with the provider before you rely on it.

## Capability matrix (current build)

| Provider id | Mode | Capability | Notes |
|---|---|---|---|
| `demo-flights` | flight | `DEMO_ONLY` | synthetic timetable/fares |
| `demo-trains` | train | `DEMO_ONLY` | synthetic |
| `demo-buses` | bus | `DEMO_ONLY` | synthetic |
| `ground-estimate` | local transfer | `SEARCH_ONLY` | configured estimates, labelled "Estimated" |

Add a live adapter by implementing `SegmentProvider` (and `BookingProvider` for in-app booking), registering it in `src/lib/providers/registry.ts`, adding contract tests, and setting its capability honestly.

## Findings by area

**Flights**
- **Amadeus Self-Service APIs were decommissioned** (registrations paused Feb 2026; portal closed 17 July 2026) per [PhocusWire](https://www.phocuswire.com/amadeus-shut-down-self-service-apis-portal-developers) and [AirLabs](https://airlabs.co/amadeus-self-service-api-shutdown). Enterprise APIs (ticketing/NDC) remain but require a negotiated sales contract ([apis.io](https://apis.io/plans/amadeus/amadeus-plans-pricing/)). Do **not** build on the self-service tier.
- Options to evaluate: Amadeus Enterprise, other GDS/NDC aggregators, Indian airline/OTA partner programmes, or affiliate deep links (search-only + outbound link). Not researched in depth here: **[OWNER/next step]** compare coverage of Indian carriers, fare access, issuance support, cancellation, rate limits, cost.

**Trains (India)**
- No public IRCTC developer portal was found. IRCTC describes B2B / B2C / e-governance partner schemes where integrations are done through IRCTC itself; unauthorised automation is not acceptable ([Outlook Business](https://www.outlookbusiness.com/news/adani-s-trainman-not-a-competition-clarifies-irctc-over-e-ticketing-business-row-news-295995), [IRCTC Tourism PSP page](https://irctctourism.com/TravelAgents/InternetTicketingAgents.html)). **External blocker:** contact IRCTC's partnership team or use an authorised partner. Until then trains stay `SEARCH_ONLY` at best (schedules from a licensed/open source) with an official outbound booking link. Do not scrape.

**Buses**
- redBus offers partner/API arrangements, but official documentation was not found in search; third-party listings are unverified. **Blocker:** apply via redBus business/partnerships. Other aggregators to evaluate similarly.

**Live flight fares: Duffel (adapter written, untested live)**
- `src/lib/providers/duffel.ts` calls `POST https://api.duffel.com/air/offer_requests?return_offers=true` with `Authorization: Bearer <token>` and `Duffel-Version: v2` (per Duffel's published docs). A test token can be created in the Duffel dashboard (More > Developers > Access tokens). The docs reviewed here do not say what is required to go live (verification, balance, fees): confirm with Duffel.
- Duffel's documented booking flow is: offer request, re-fetch the offer for the current price, then create an order with passenger details and a payment of type `balance` (or `arc_bsp_cash` for IATA agents). Booking is not implemented here.
- Set `DUFFEL_ACCESS_TOKEN` and `DUFFEL_FX_RATES` (INR per unit of each currency) in the host dashboard.

**Places / stations**
- The planner uses open data: GeoNames (34k cities, 2.8k states/regions; CC BY 4.0) and OurAirports (airports, heliports, seaplane bases; public domain), plus 79 hand-curated hub cities. Every scheduled airport becomes a route node. Stations and bus stands are generated placeholders, not real station data. For production, license a places/airport/station dataset (e.g. IATA/OurAirports for airports; railway station codes from an authorised source) and keep manual-entry fallback.

**Local transfers**
- Static estimates only; labelled as estimates. A taxi/ride API would require its own agreement.

**Payments**
- No payment integration is included. If you charge fees or take payment yourself, use a hosted checkout (e.g. Razorpay/Stripe) with server-side verification via signed webhooks; this needs a registered business and KYC. Prefer provider-side payment so the app never handles card data.

## Launch strategy that stays honest

1. Launch as a **planner with demo data clearly labelled**, or with licensed schedule data + outbound official booking links (`SEARCH_ONLY`).
2. Add `QUOTE_AND_BOOK` per provider only after: signed agreement, sandbox contract tests, durable store, webhook verification, reconciliation job, and legal review.
