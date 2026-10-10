# Privacy data map

| Data | Purpose | Where stored | Sent to | Retention |
|---|---|---|---|---|
| Email, password hash, Google profile id | Account | Supabase Auth | – | Until account deletion |
| Profile (display name, consent flags) | Account settings | `profiles` | – | Until deletion |
| Search constraints (origin, dest, date, prefs) | Planning, saved journeys | `saved_searches`, `trips` | Providers (route/date only) | User-deletable; deleted with account |
| Chat text (≤ 500 chars) | Interpret constraints | Not stored | Optional LLM provider (only text; never passenger data) | Not retained by us |
| Quotes (itinerary snapshot, price) | Booking confirmation | `quotes` | – | Short-lived; deleted with account |
| Booking ledger (status, amount, provider ref, count) | Transaction record | `bookings`, audit events | Provider | Retained as law/provider rules require [OWNER: set period] |
| Passenger names/ages | Ticketing | **Not stored**; passed to provider at purchase | Booking provider | n/a |
| Payment card data | – | **Never handled**; use provider hosted checkout | Payment processor | n/a |
| IP address, request id, error logs | Security, rate limit | Host logs / Upstash counters (short TTL) | Host | [OWNER: log retention] |
| Voice input (optional mic) | Dictate chat questions | Audio is **not** received or stored by us; the browser's Web Speech API converts it to text (Chrome/Edge send audio to the vendor's speech service) | Browser vendor speech service | We keep only the resulting chat text (see chat row) |
| Spoken answers (text-to-speech) | Read answers aloud | Generated on-device by the browser | – | – |
| Device location (optional, "Use my location") | Pick the nearest start city | Read once in the browser after you tap the button; converted to a city name on-device; coordinates are never sent to or stored by us | – | None |
| Manual booking checklist (references, amounts you type) | Track your own bookings | Browser localStorage on your device only | – | Until you reset or clear site data |
| Payment records (gateway, amount, status, gateway order/transaction ids) | Take and reconcile payment | `payments` table (no card or UPI details ever reach us) | PhonePe / PayPal | Retained as tax/accounting rules require [OWNER: period] |
| Passenger names/ages during checkout | Buy tickets after payment | Held temporarily (encrypted column), deleted right after the purchase call or on failure, 2-hour expiry | Booking provider at purchase | Minutes to 2 hours |
| Place search text (autocomplete, up to 80 chars) | Suggest cities, states and airports | Sent to `/api/places`, answered from bundled open data; not stored or forwarded | – | Not retained |
| Turnstile token | Bot check | Not stored | Cloudflare | – |

Logs redact keys matching password/token/secret/authorization/cookie/api key/card/name/email/phone/dob/passport/aadhaar/pan. Audit notes are ≤ 200 chars and must not contain PII.

Rights tooling: `GET /api/account` (export), `DELETE /api/account?confirm=DELETE` (erase; see SECURITY.md limitation 5), saved-trip delete in dashboard.

Play Console Data safety (draft): collects email (account management), approximate IP (security), no location, no contacts, no payment data in-app; data encrypted in transit; users can request deletion (web path: `/account`). **[OWNER: verify against final integrations.]**
