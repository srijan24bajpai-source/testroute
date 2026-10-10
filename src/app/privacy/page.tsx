import type { Metadata } from "next";
import { brand } from "@/config/brand";

export const metadata: Metadata = { title: "Privacy policy (template)" };

export default function Privacy() {
  return (
    <article className="card">
      <h1>Privacy policy</h1>
      <div className="banner">TEMPLATE — not legal advice. The site owner must review it with a qualified lawyer and complete every [OWNER: …] field before launch.</div>
      <p><strong>Operator:</strong> {brand.legalEntity}, [OWNER: registered address]. <strong>Contact:</strong> {brand.supportEmail}. <strong>Grievance/Data Protection contact:</strong> [OWNER: name &amp; email].</p>
      <h2>What we collect</h2>
      <ul>
        <li>Account data: email address and (if you use Google sign-in) basic profile identifiers supplied by Google.</li>
        <li>Trip data: searches, saved journeys and preferences you choose to save.</li>
        <li>Booking data (only if in-app booking is enabled): traveller names and ages needed by the ticket provider, booking references, and amounts. We do not store card numbers; payments are handled by the provider or a payment processor.</li>
        <li>Voice (optional): if you tap the microphone, your browser's built-in speech recognition converts your speech to text. In Chrome and Edge the audio is processed by the browser vendor's speech service (for example Google or Microsoft), under their privacy terms, not by us. We receive only the resulting text and never record, upload or store audio. Spoken answers are generated on your device.</li>
        <li>Location (optional): if you tap “Use my location”, your browser shares your position once; we turn it into the nearest city on your device and never send or store the coordinates. Your manual-booking checklist (references and amounts you type) stays in your browser only.</li>
        <li>Payments (only if enabled): you pay on PhonePe or PayPal's own pages; we never see your card, UPI PIN or account details, only the payment status, amount and reference. Traveller names and ages you enter for a booking are kept only briefly to complete the purchase and then deleted.</li>
        <li>Technical data: IP address and request logs for security and abuse prevention, with sensitive fields redacted.</li>
      </ul>
      <h2>How we use it</h2>
      <p>To search and plan journeys, operate your account, process bookings you confirm, prevent abuse, and meet legal obligations. Chat text may be sent to an AI model provider only to interpret trip constraints; traveller identity details are never sent to it.</p>
      <h2>Sharing</h2>
      <p>With travel providers and payment processors to fulfil a booking you confirm; with infrastructure providers (hosting, database, authentication, bot protection) acting for us. [OWNER: list actual vendors.]</p>
      <h2>Retention and deletion</h2>
      <p>Saved journeys and searches are deleted on request or when you delete your account. Booking and payment records may be retained for [OWNER: period] where tax, accounting or provider rules require it. You can export or delete your data on the Account page.</p>
      <h2>Your rights</h2>
      <p>[OWNER: describe rights under applicable law, e.g. India’s DPDP Act 2023 and any other laws that apply to your users, and how to exercise them.]</p>
      <h2>Analytics and cookies</h2>
      <p>We use only strictly necessary cookies (sign-in session). Optional analytics are off unless you consent. [OWNER: update if you add analytics.]</p>
      <h2>Changes</h2>
      <p>Last updated: [OWNER: date].</p>
    </article>
  );
}
