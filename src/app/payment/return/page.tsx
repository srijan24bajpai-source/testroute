"use client";
import Link from "next/link";
import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { formatInr } from "@/lib/domain/money";

type View = { status: string; amountPaise: number; chargedMinor: number; chargedCurrency: string; bookingStatus: string | null; bookingReference: string | null };

function Inner() {
  const pid = useSearchParams().get("pid") ?? "";
  const cancelled = useSearchParams().get("cancelled") === "1";
  const [v, setV] = useState<View | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let stop = false;
    let tries = 0;
    async function poll() {
      try {
        const r = await fetch(`/api/payments/${encodeURIComponent(pid)}`);
        const d = await r.json();
        if (!r.ok) return setErr(d?.error?.message ?? "Could not check your payment.");
        if (stop) return;
        setV(d.payment);
        const settled = d.payment.status !== "PENDING" && d.payment.bookingStatus !== "BOOKING_IN_PROGRESS";
        if (!settled && ++tries < 40) setTimeout(poll, 3000);
      } catch {
        setErr("Network error while checking your payment.");
      }
    }
    if (pid) void poll();
    return () => { stop = true; };
  }, [pid]);

  if (err) return <div className="card"><h1>Payment</h1><p className="err">{err}</p></div>;
  if (!v) return <div className="card"><h1>Checking your payment…</h1><div className="skeleton" /></div>;

  const confirmed = v.bookingStatus === "CONFIRMED" && v.bookingReference;
  return (
    <div className="card">
      <h1>{confirmed ? "Booking confirmed" : v.status === "COMPLETED" ? "Payment received" : v.status === "PENDING" ? (cancelled ? "Payment not completed" : "Waiting for payment…") : "Payment update"}</h1>
      <p>Amount: {formatInr(v.amountPaise)}{v.chargedCurrency !== "INR" && <> (charged as {(v.chargedMinor / 100).toFixed(2)} {v.chargedCurrency})</>}</p>
      {confirmed && <p><strong>Booking reference: {v.bookingReference}</strong> (issued by the provider).</p>}
      {v.status === "COMPLETED" && !confirmed && v.bookingStatus !== "FAILED" && <p>Your payment is confirmed. We are completing your booking; this page updates automatically. <strong>You are not booked until a reference appears here.</strong></p>}
      {(v.status === "REFUND_REQUIRED" || v.bookingStatus === "FAILED") && v.status !== "FAILED" && <p className="err">We received your payment but could not complete the booking. A refund is required and will be handled; please contact support with this page&apos;s address.</p>}
      {v.status === "FAILED" && <p className="err">The payment did not go through. Nothing was booked.</p>}
      {v.status === "REVIEW_REQUIRED" && <p className="err">The payment amount did not match. Nothing was booked. Please contact support.</p>}
      <Link href="/dashboard">Go to my trips</Link>
    </div>
  );
}

export default function PaymentReturn() {
  return <Suspense fallback={<div className="skeleton" />}><Inner /></Suspense>;
}
