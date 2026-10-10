"use client";
import { useRef, useState } from "react";
import type { Constraints, Itinerary } from "@/lib/domain/types";
import { formatInr } from "@/lib/domain/money";

type Quote = { id: string; hash: string; totalGroup: number; passengers: number; expiresAt: string; conditions: string[]; bookable: boolean };
type Pax = { fullName: string; age: string };

/**
 * Pay-then-book checkout. Only rendered when the server reports both a live booking connection and at least
 * one configured payment gateway. The amount is whatever the server quoted: the browser never sends a price.
 */
export function CheckoutPanel({ it, constraints, gateways }: { it: Itinerary; constraints: Partial<Constraints>; gateways: ("phonepe" | "paypal")[] }) {
  const [quote, setQuote] = useState<Quote | null>(null);
  const [pax, setPax] = useState<Pax[]>(() => Array.from({ length: it.cost.passengers }, () => ({ fullName: "", age: "" })));
  const [agree, setAgree] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [disclosure, setDisclosure] = useState<string | null>(null);
  const idem = useRef(crypto.randomUUID().replace(/-/g, "") + "pay"); // one key per checkout attempt: double-clicks are safe

  async function review() {
    setBusy(true); setMsg(null);
    try {
      const res = await fetch("/api/quotes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ constraints, itineraryId: it.id }) });
      const d = await res.json();
      if (res.status === 401 || res.status === 503) return setMsg(res.status === 401 ? "Please sign in to pay and book." : "Accounts are not configured on this site.");
      if (!res.ok) return setMsg(d?.error?.message ?? "Could not prepare your quote.");
      if (!d.quote.bookable) return setMsg("This itinerary cannot be booked here.");
      setQuote(d.quote);
    } finally {
      setBusy(false);
    }
  }

  async function pay(gateway: "phonepe" | "paypal") {
    if (!quote) return;
    setBusy(true); setMsg(null);
    try {
      const res = await fetch("/api/checkout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          gateway, quoteId: quote.id, quoteHash: quote.hash, acknowledgedTotal: quote.totalGroup, acceptedConditions: true, idempotencyKey: idem.current,
          passengers: pax.map((p) => ({ fullName: p.fullName.trim(), age: Number(p.age) })),
        }),
      });
      const d = await res.json();
      if (res.status === 409 && d.quote) { setQuote(d.quote); setAgree(false); idem.current = crypto.randomUUID().replace(/-/g, "") + "pay"; return setMsg(d.message); }
      if (!res.ok) return setMsg(d?.error?.message ?? "Could not start the payment. Nothing was charged.");
      if (d.disclosure) setDisclosure(d.disclosure);
      if (typeof d.redirectUrl === "string" && d.redirectUrl.startsWith("https://")) window.location.assign(d.redirectUrl);
      else setMsg("Payment started. Check your trips page for status.");
    } catch {
      setMsg("Network error. Nothing was charged; please try again.");
    } finally {
      setBusy(false);
    }
  }

  const valid = pax.every((p) => p.fullName.trim().length >= 2 && Number(p.age) >= 0 && Number(p.age) <= 120 && p.age !== "");

  if (!quote) {
    return (
      <div className="card" aria-label="Checkout">
        <h2 style={{ marginTop: 0 }}>Pay and book</h2>
        <p className="muted">We will re-check the live price first and show you the exact total before you pay.</p>
        {msg && <p className="err">{msg}</p>}
        <button className="primary" type="button" onClick={review} disabled={busy}>{busy ? "Checking…" : "Review final price"}</button>
      </div>
    );
  }
  return (
    <div className="card" aria-label="Checkout">
      <h2 style={{ marginTop: 0 }}>Confirm and pay</h2>
      <p><strong>Total: {formatInr(quote.totalGroup)}</strong> for {quote.passengers} traveller(s). Valid until {new Date(quote.expiresAt).toLocaleTimeString()}.</p>
      {pax.map((p, i) => (
        <div className="row" key={i} style={{ marginBottom: 8 }}>
          <input aria-label={`Traveller ${i + 1} full name (as on ID)`} placeholder="Full name (as on ID)" maxLength={80} value={p.fullName} onChange={(e) => setPax(pax.map((x, j) => (j === i ? { ...x, fullName: e.target.value } : x)))} style={{ flex: 1, minWidth: 200 }} />
          <input aria-label={`Traveller ${i + 1} age`} placeholder="Age" inputMode="numeric" maxLength={3} value={p.age} onChange={(e) => setPax(pax.map((x, j) => (j === i ? { ...x, age: e.target.value.replace(/\D/g, "") } : x)))} style={{ width: 90 }} />
        </div>
      ))}
      <ul className="muted">{quote.conditions.map((c) => <li key={c}>{c}</li>)}</ul>
      <label className="row" style={{ margin: "8px 0" }}><input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} /> I have checked the details and accept these conditions.</label>
      {disclosure && <p className="banner">{disclosure}</p>}
      <div className="row">
        {gateways.map((g, i) => (
          <button key={g} type="button" className={i === 0 ? "primary" : ""} disabled={busy || !agree || !valid} onClick={() => pay(g)}>
            {g === "phonepe" ? `Pay ${formatInr(quote.totalGroup)} with PhonePe (UPI, cards)` : "Pay with PayPal"}
          </button>
        ))}
      </div>
      <p className="muted">You are only booked once a provider booking reference appears after payment. Passenger details are used for the purchase and then deleted from our systems.</p>
      {msg && <p className="err" role="alert">{msg}</p>}
    </div>
  );
}
