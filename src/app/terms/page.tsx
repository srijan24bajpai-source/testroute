import type { Metadata } from "next";
import { brand } from "@/config/brand";

export const metadata: Metadata = { title: "Terms of service (template)" };

export default function Terms() {
  return (
    <article className="card">
      <h1>Terms of service</h1>
      <div className="banner">TEMPLATE — not legal advice. The site owner must complete every [OWNER: …] field and have this reviewed before launch.</div>
      <p><strong>Provider of the service:</strong> {brand.legalEntity}, [OWNER: registered address]. Contact: {brand.supportEmail}.</p>
      <h2>What {brand.name} does</h2>
      <p>{brand.name} helps you plan journeys by combining schedules and fares from third-party providers. Unless a booking is explicitly confirmed with a provider-issued reference, nothing has been reserved or ticketed.</p>
      <h2>Demo data</h2>
      <p>Where results are labelled “Demo”, they are examples only: not live availability and not bookable fares.</p>
      <h2>Prices and availability</h2>
      <p>Fares and availability come from providers and can change at any time. Estimates (for example local transfers) are not quotes. We re-check the price before purchase and ask you to confirm the exact amount.</p>
      <h2>Separate tickets</h2>
      <p>Multi-leg trips are usually separate tickets. If a leg is delayed or cancelled, later legs may not be protected or refundable.</p>
      <h2>Cancellation and refunds</h2>
      <p>Governed by each provider’s rules. We never promise a refund that the provider has not confirmed. [OWNER: add your own service-fee policy.]</p>
      <h2>Acceptable use</h2>
      <p>No scraping, automated polling, bulk account creation, or attempts to bypass security or rate limits.</p>
      <h2>Liability, governing law, disputes</h2>
      <p>[OWNER: complete with advice from counsel.]</p>
    </article>
  );
}
