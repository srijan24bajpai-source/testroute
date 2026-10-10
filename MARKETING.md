# RoutePilot AI: marketing plan and copy

Honesty rule: the app currently plans on **demo/estimated data** and does **not sell tickets**. Every claim below is true today. Do not advertise "live prices", "book in the app" or "pay with UPI/PayPal" until `/api/health` shows live fares, a booking provider and payments enabled. (Misleading ads also get Google/Meta accounts banned and can breach consumer law.)

## Positioning
- One-liner: **"Plan the whole journey, not just one leg. Trains, flights and buses in one route."**
- Audience 1: Indian travellers doing multi-leg trips (e.g. Jammu → Kanyakumari) who juggle IRCTC, redBus and airline sites.
- Audience 2: backpackers/digital nomads wanting any-city-to-any-city plans worldwide.
- Differentiators: door-to-door multi-modal routing, fastest/cheapest ranking, realistic layover buffers, 3 modes (view / guided booking links / "plan it for me"), voice input, any city or airport worldwide, privacy-first (account export + delete).

## Phase 0: before any promotion (blockers)
1. Replace placeholders in `src/config/brand.ts` (support email, legal entity) and `/privacy`, `/terms`.
2. Finish login test (GO_LIVE.md §1).
3. Buy/point a real domain; set `APP_ORIGIN` in Vercel (sitemap and share cards use it).
4. Add a 1200x630 share image at `src/app/opengraph-image.png`.
5. Add analytics that respects consent (Plausible/Umami) and a waitlist/email capture.

## Phase 1: free launch (weeks 1-2), "build in public"
- **Product Hunt**: tagline "AI journey planner: trains + flights + buses in one route". Say "demo data, live fares coming" in the first comment.
- **Reddit** (read each sub's self-promo rules first): r/india, r/IndiaTravel, r/solotravel, r/digitalnomad, r/SideProject. Post as a story ("I built a planner for the Jammu→Kanyakumari problem"), not an ad.
- **Hacker News "Show HN"**, **Indie Hackers**, **X/LinkedIn** build thread, **dev.to** write-up on the routing engine (pruned multi-modal search, layover buffers).
- 30-60 s screen recording: type "Delhi to Kanyakumari under ₹6000", show ranked itineraries. Post on Reels/Shorts/LinkedIn.

## Phase 2: SEO (weeks 2-8)
Programmatic pages are the highest-leverage channel: `/routes/delhi-to-goa`, `/routes/mumbai-to-manali` with duration, modes, tips. Only publish pages with genuinely useful, non-duplicated content; label estimates. Target long-tail: "how to reach Kanyakumari from Jammu", "Delhi to Leh by road and air", "cheapest way Delhi to Goa".

## Phase 3: paid (only once live fares + booking exist)
- Start ₹500-1000/day Google Search on high-intent route keywords, plus Meta/Instagram Reels to 22-35 travellers. Measure cost per signup, then cost per booking.
- Affiliate/referral: travel bloggers and YouTubers get a code, paid per completed booking.

## Copy bank
**Tweet/LinkedIn:** "Going from Jammu to Kanyakumari takes 3 trains, a bus and maybe a flight. I built RoutePilot AI to plan the whole thing in one search, fastest vs cheapest, with real layover buffers. Free to try (demo data for now): airoutepilot.vercel.app"

**Product Hunt description:** "RoutePilot AI turns 'I want to get from A to B' into ranked door-to-door itineraries across trains, flights and buses, anywhere from small Indian cities to airports worldwide. Talk or type, compare fastest vs cheapest, then follow guided links to book each leg. Fares are estimates for now; live fares are on the roadmap."

**Google Play short description (80 chars):** "Plan multi-leg trips by train, flight and bus. Fastest or cheapest, one search."

**Email 1 (waitlist):** Subject: "Your whole journey, one search". Body: what it does, 1 screenshot, "demo data today, live fares next", link, reply-to question: "Which trip do you wish was easier?"

## Metrics to track
Visits → searches run → sign-ups → saved trips → (later) bookings. Weekly review; double down on the one channel with the best signup rate.

## Not possible from here
Posting to your social accounts, buying ads, or submitting to Play/Product Hunt needs your accounts and approval. The copy above is ready to paste.
