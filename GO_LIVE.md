# Go live: user login, PayPal, Google Play

Status checked on the live site (`/api/health`): the website is up, **login is configured (`auth: true`)**, payments are **off**, booking is **not connected**. This page lists exactly what only you can do, in order.

---

## 1. User login (Supabase): finish and test

The code is done (email + password with verification, Google sign-in, password reset, account export/delete). You need:

1. **Run the SQL:** Supabase → SQL Editor → New query → paste the whole file `supabase-setup.sql` (= migrations 0001 + 0002; verified in a PostgreSQL engine) → Run. Run it once only.
2. **Vercel env vars** (Production): `STORE_DRIVER=supabase` and `PASSENGER_DATA_KEY` (generate: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`). Redeploy.
3. **Supabase → Authentication:** turn on "Confirm email". URL configuration: Site URL = `https://airoutepilot.vercel.app`; add Redirect URL `https://airoutepilot.vercel.app/auth/callback`.
4. *(Optional)* **Google sign-in:** Google Cloud → OAuth client (Web) → paste client id/secret into Supabase → Authentication → Providers → Google; add Supabase's callback URL to the Google client. Never put the Google secret in Vercel or the repo.
5. **Test:** Sign up → open the verification email → sign in → "My trips" opens (no "not enabled" message). Delete the test account on the *Account & data* page.

Nothing in the chat, repo or app logs contains passwords; keys stay in the dashboards.

---

## 2. PayPal: accept payments worldwide

**Be clear about what this does today.** The PayPal integration is built (create order → buyer approves → server captures → amount/currency checked → *then* the ticket purchase). It is deliberately **blocked until a live ticket provider exists**, because otherwise a customer could pay for a ticket the app cannot issue. With no provider connected, `/api/checkout` answers "payments not available" and no one can be charged. That is the safe behaviour; do not bypass it.

When a ticket provider is connected, enabling PayPal is only configuration:

1. PayPal **Business** account (verified) → developer.paypal.com → *Apps & Credentials* → create an app (start in **Sandbox**) → copy Client ID and Secret.
2. PayPal → Webhooks → add `https://airoutepilot.vercel.app/api/payments/webhook/paypal`, event `PAYMENT.CAPTURE.COMPLETED` (plus other capture/order events) → copy the **Webhook ID**.
3. Vercel env vars: `PAYMENTS_ENABLED=true`, `PAYMENT_GATEWAYS=paypal`, `PAYPAL_ENV=sandbox` (use `live` only after testing), `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_WEBHOOK_ID`, `PAYPAL_CURRENCY=USD`, `PAYPAL_INR_PER_UNIT=<current rate>` (PayPal's documentation says Indian accounts cannot receive INR, so buyers are charged a converted amount which they see before paying). Keep the rate current.
4. Run the full sandbox checklist in `PAYMENTS.md`. Refunds are **manual** today (PayPal dashboard); automate or document them before real money.
5. India-specific: receiving foreign payments for services involves PayPal purpose codes and tax/GST/FEMA rules. Confirm with PayPal and your CA before going live.

If you want to earn money *before* a ticket provider exists, that needs a different product (for example a paid planning plan or a service fee). That is a business decision; tell me and I will design it. I will not switch on charging for a booking the app cannot fulfil.

---

## 2b. PhonePe (UPI, cards, wallets; India, INR only)

PhonePe is already built in (OAuth token → create payment → redirect → server-side status check → webhook) and is the first gateway offered by default. The same safety rule applies as for PayPal: **it stays blocked until a live ticket provider exists**, and customers outside India cannot normally pay with it.

1. **Merchant account:** PhonePe Business / Payment Gateway onboarding (business KYC). Ask for **sandbox** credentials first: Client ID, Client Secret, Client Version.
2. **Webhook (PhonePe dashboard):** URL `https://airoutepilot.vercel.app/api/payments/webhook/phonepe`, and choose a webhook username and password. PhonePe sends `Authorization: SHA256(username:password)`; the server checks it. Confirm the exact header format in the sandbox.
3. **Vercel env vars:** `PAYMENTS_ENABLED=true`, `PAYMENT_GATEWAYS=phonepe`, `PHONEPE_ENV=sandbox`, `PHONEPE_CLIENT_ID`, `PHONEPE_CLIENT_SECRET`, `PHONEPE_CLIENT_VERSION`, `PHONEPE_WEBHOOK_USERNAME`, `PHONEPE_WEBHOOK_PASSWORD`. Switch `PHONEPE_ENV` to `production` only after the sandbox checklist in `PAYMENTS.md` passes. Secrets go in the Vercel dashboard only.
4. **Verify:** `/api/health` should list `"payments":{"enabled":true,"gateways":["phonepe"]}`. Checkout still answers "booking not available" until a ticket provider is connected, by design.
5. Refunds are manual (PhonePe dashboard) for now.

For customers worldwide, offer both (`PAYMENT_GATEWAYS=phonepe,paypal`): PhonePe for Indian buyers, PayPal for everyone else.

---

## 3. Google Play

I cannot publish to Google Play: it needs **your** Play Console account, **your** signing key, and Google's review. Everything I could prepare is ready; these are the steps.

**A. Accounts and rules (check the current requirements in Play Console; they change)**
- Play Console developer account (one-time registration fee, identity verification).
- New *personal* accounts have typically had to run a **closed test with at least 12 testers for 14 days** before production access. Confirm for your account type.

**B. Choose the permanent app ID** (Play rejects `com.example.*`; you cannot change it after upload). Then run, from the project folder:
```
node scripts/configure-android.mjs --id com.yourname.routepilot --url https://airoutepilot.vercel.app
```
It updates the app ID, the deep-link scheme, the website address and the Java package everywhere (tested; `--dry-run` shows changes first). Then add the printed redirect `com.yourname.routepilot://auth/callback` to Supabase → Redirect URLs.

**C. Build the signed bundle (.aab)** (this computer has no Java/Android SDK, so I could not build or test it):
1. Install **Android Studio** (it includes the JDK, SDK and license prompts).
2. `npm ci` then `CAP_SERVER_URL=https://airoutepilot.vercel.app npx cap sync android`.
3. Android Studio → open the `android` folder → *Build → Generate Signed App Bundle → Android App Bundle* → create a new keystore (**store it outside the project and back it up; never commit it**) → *release*.
4. Output: `android/app/build/outputs/bundle/release/app-release.aab`.

**D. Play Console:** create the app → upload the `.aab` to **Internal testing** first → enrol in Play App Signing → copy the **SHA-256 of the app signing certificate** → put it in `assetlinks.template.json` and publish the file as `public/.well-known/assetlinks.json` on the website (redeploy) so App Links verify.

**E. Listing and declarations** (draft text in `PLAY_STORE_LISTING.md`): complete the **privacy policy** at `/privacy` (all `[OWNER: …]` fields; a template is not enough for review), Data safety form (`PRIVACY_DATA_MAP.md`), content rating, target audience, and the **account deletion** URL `https://airoutepilot.vercel.app/account`. Provide a test login for reviewers (created on the live site, no payment access) in *App access*. Describe the app truthfully: it plans journeys on **demo data** and does not sell tickets yet.

**Likely review risks:** an app that is only a website wrapper can be rejected for minimal functionality; labelled demo data may be judged misleading unless the listing says so clearly; any payment feature needs the right declarations. Add genuinely native value (for example sharing a plan, calendar export, notifications) before submitting.

**Order I recommend:** (1) finish login → (2) connect a real data/ticket provider (Duffel test token first) → (3) Play internal testing → (4) closed test → (5) production. Publishing before there is real data or booking will likely stall in review.
