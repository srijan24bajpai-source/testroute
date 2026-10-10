# Payments: PhonePe and PayPal

**Status: implemented and unit-tested with mocked gateways; never run against the real PhonePe or PayPal sandbox; OFF by default.** Nothing can charge a card or UPI account until (1) `PAYMENTS_ENABLED=true`, (2) a gateway's credentials are set in the host dashboard, **and** (3) a live booking provider exists, because money is only collected for a trip that can actually be bought. Today there is no live booking provider, so the checkout never appears and `/api/checkout` answers `PAYMENTS_NOT_AVAILABLE` / `BOOKING_NOT_AVAILABLE`.

## Flow (pay, then book)
1. Server builds a quote (price re-checked with the provider; hash-bound to user, segments, total and conditions).
2. `POST /api/checkout` with the quote id/hash, the exact total the traveller saw, consent, traveller names and an idempotency key. **There is no amount field**; the server charges the quote total only.
3. Server re-prices once more. If the fare moved, it returns a new quote and charges nothing.
4. Server creates a booking (`PAYMENT_PENDING`), a payment row, and the gateway order; the browser is redirected to the gateway.
5. The traveller pays. The redirect back to `/payment/return` proves nothing: that page polls `GET /api/payments/{id}`, which asks the gateway server-to-server.
6. A webhook may also arrive. It only authenticates the call and names the payment; the status is **always re-fetched from the gateway**. A forged or lying webhook cannot confirm anything.
7. Only when the gateway reports `COMPLETED` **and** the amount and currency equal what we asked for does the server call the provider to buy the tickets (once, even if poll and webhook race). A booking is `CONFIRMED` only with a provider reference.
8. If the purchase is declined after payment, the payment is flagged `REFUND_REQUIRED`. If the amount differs, `REVIEW_REQUIRED` and nothing is bought.

## What is NOT automated yet (important)
- **Refunds.** `REFUND_REQUIRED` / `REVIEW_REQUIRED` rows must be refunded by a person in the PhonePe/PayPal dashboard. There is no refund API call, admin screen, or alerting yet. Do not take real money before this exists.
- Reconciliation job for payments stuck in `PENDING`, and for bookings stuck in `RECONCILIATION_REQUIRED` after payment.
- Live database check: the Supabase store (`STORE_DRIVER=supabase`) is written and emulator-tested but not yet run against a real project; migrations `0001`/`0002` are unexecuted.
- Traveller names are AES-256-GCM encrypted (`PASSENGER_DATA_KEY`), read once and deleted, with a 2-hour expiry; a scheduled purge of leftover rows (`delete from booking_passengers_tmp where expires_at < now()`) is still to be set up.

## PhonePe setup (Standard Checkout v2)
1. Create a PhonePe Business / PG merchant account (business KYC required) and get **Client ID, Client Secret, Client Version** for sandbox first.
2. In the dashboard set the webhook URL `https://YOUR-DOMAIN/api/payments/webhook/phonepe` and choose a webhook username/password. PhonePe sends `Authorization: SHA256(username:password)`; the server compares in constant time. *Verify the exact header casing/format in sandbox.*
3. Set `PHONEPE_*` variables in Vercel (Preview = sandbox values, Production = live values), `PHONEPE_ENV=production` only for live.
4. Endpoints used: OAuth `.../v1/oauth/token`, `POST /checkout/v2/pay`, `GET /checkout/v2/order/{merchantOrderId}/status` (sources: PhonePe developer docs). Amounts are paise (minimum 100).

## PayPal setup (Orders v2)
1. Create a PayPal Business account; in the developer dashboard create an app (sandbox first) and copy **Client ID / Secret**.
2. **INR limitation:** PayPal's developer documentation states Indian PayPal accounts cannot receive INR. This integration therefore charges in `PAYPAL_CURRENCY` (default USD) converted at `PAYPAL_INR_PER_UNIT`, which **you** must keep current. The buyer sees the converted amount and rate before paying; PayPal may add its own fees/exchange. Confirm with PayPal which currencies and buyer countries your account may accept. Currency-conversion and cross-border rules need advice from your CA.
3. Add a webhook `https://YOUR-DOMAIN/api/payments/webhook/paypal` for `PAYMENT.CAPTURE.COMPLETED` (and related capture/order events) and copy the **Webhook ID** into `PAYPAL_WEBHOOK_ID`. Verification uses PayPal's `verify-webhook-signature` API.
4. Set `PAYPAL_*`; use `PAYPAL_ENV=live` only for production.

## Test before going live
Run the full flow in both sandboxes: success, user cancel, failure, duplicate click, webhook-before-return, return-before-webhook, wrong-amount simulation, gateway outage. Only then enable live keys.

## Security properties (covered by `tests/payments.test.ts`)
Server-owned amount; idempotent checkout; compare-and-set settlement (single purchase under races); webhook authentication and server-side re-verification; amount/currency equality check; payment status endpoint is owner-only (foreign ids look like missing ones); passenger details deleted after use; gateway secrets server-only; return URLs built from `APP_ORIGIN`, never from request data.

## Changing gateways (summary; full table in DEPLOY_VERCEL.md)
- `PAYMENT_GATEWAYS=phonepe,paypal` picks which gateways may be offered and in which order (one name = only that gateway).
- To add another gateway, implement `PaymentGateway` (`src/lib/payments/types.ts`), register it in `src/lib/payments/registry.ts`, and extend the `GatewayId` type. Settlement, idempotency, amount checks and webhook handling are shared and need no change.
