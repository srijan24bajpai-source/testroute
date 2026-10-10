"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { formatInr } from "@/lib/domain/money";

type Booking = { id: string; status: string; externalRef: string | null; totalGroup: number; passengerCount: number; createdAt: string; paymentUrl: string | null };
type Trip = { id: string; title: string; createdAt: string };

const GROUPS: [string, string[]][] = [
  ["Confirmed bookings", ["CONFIRMED"]],
  ["Pending", ["PENDING_USER_CONFIRMATION", "QUOTE_REFRESH_REQUIRED", "BOOKING_IN_PROGRESS", "PAYMENT_PENDING", "RECONCILIATION_REQUIRED", "CANCEL_REQUESTED", "REFUND_PENDING"]],
  ["Cancelled / failed", ["CANCELLED", "FAILED"]],
];

export default function Dashboard() {
  const [state, setState] = useState<"loading" | "anon" | "unavailable" | "ready">("loading");
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [trips, setTrips] = useState<Trip[]>([]);

  async function load() {
    const [b, t] = await Promise.all([fetch("/api/bookings"), fetch("/api/trips")]);
    if (b.status === 401 || b.status === 403) return setState("anon");
    if (b.status === 503) return setState("unavailable");
    if (!b.ok) return setState("unavailable");
    setBookings((await b.json()).bookings);
    setTrips(t.ok ? (await t.json()).trips : []);
    setState("ready");
  }
  useEffect(() => { void load(); }, []);

  async function del(id: string) {
    await fetch(`/api/trips?id=${id}`, { method: "DELETE" });
    void load();
  }

  if (state === "loading") return <div className="skeleton" />;
  if (state === "unavailable") return <div className="card"><h1>My trips</h1><p>Accounts are not configured on this deployment yet.</p></div>;
  if (state === "anon") return <div className="card"><h1>My trips</h1><p><Link href="/login">Sign in</Link> to see saved journeys and bookings.</p></div>;

  return (
    <>
      <h1>My trips</h1>
      <section className="card">
        <h2>Saved journeys (not booked)</h2>
        {trips.length === 0 ? <p className="muted">Nothing saved yet. <Link href="/">Plan a trip</Link>.</p> : (
          <ul>{trips.map((t) => <li key={t.id}>{t.title} <button type="button" onClick={() => void del(t.id)}>Delete</button></li>)}</ul>
        )}
      </section>
      {GROUPS.map(([title, statuses]) => {
        const rows = bookings.filter((b) => statuses.includes(b.status));
        return (
          <section className="card" key={title}>
            <h2>{title}</h2>
            {rows.length === 0 ? <p className="muted">None.</p> : (
              <table><tbody>{rows.map((b) => (
                <tr key={b.id}>
                  <td>{b.status.replaceAll("_", " ").toLowerCase()}</td>
                  <td>{formatInr(b.totalGroup)}</td>
                  <td>{b.status === "CONFIRMED" && b.externalRef ? `Ref ${b.externalRef}` : "No confirmed reference yet"}</td>
                </tr>
              ))}</tbody></table>
            )}
          </section>
        );
      })}
      <p className="muted">Need help? See <Link href="/terms">Terms</Link> or contact support (address set by the site owner).</p>
    </>
  );
}
