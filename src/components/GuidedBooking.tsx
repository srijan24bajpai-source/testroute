"use client";
import { useEffect, useMemo, useState } from "react";
import type { Itinerary } from "@/lib/domain/types";
import { formatInr } from "@/lib/domain/money";
import { formatDuration, formatLocal } from "@/lib/domain/time";
import { officialLink } from "@/lib/links";

type Progress = { done: Record<string, boolean>; ref: Record<string, string>; paid: Record<string, string> };
const EMPTY: Progress = { done: {}, ref: {}, paid: {} };
const ICON = { flight: "✈", train: "🚆", bus: "🚌", ground: "🚕" } as const;

function load(key: string): Progress {
  try {
    const raw = localStorage.getItem(key);
    if (raw) return { ...EMPTY, ...(JSON.parse(raw) as Progress) };
  } catch {
    /* storage unavailable or corrupt: start fresh */
  }
  return EMPTY;
}

/**
 * Manual, step-by-step booking guide. The traveller books each leg themselves on the provider's official site.
 * Progress, references and amounts are typed in by the user and kept ONLY on this device. They are
 * self-reported: nothing here proves a ticket exists.
 */
export function GuidedBooking({ it, onClose }: { it: Itinerary; onClose: () => void }) {
  const key = `rp-guide:${it.id}`;
  const [p, setP] = useState<Progress>(EMPTY);
  useEffect(() => setP(load(key)), [key]);

  const save = (next: Progress) => {
    setP(next);
    try {
      localStorage.setItem(key, JSON.stringify(next));
    } catch {
      /* not persisted */
    }
  };

  const legs = useMemo(() => it.segments.filter((s) => s.mode !== "ground"), [it]);
  const doneCount = legs.filter((s) => p.done[s.id]).length;
  const paidTotal = legs.reduce((sum, s) => sum + (Number(p.paid[s.id]) || 0), 0);
  const demo = it.source !== "live";

  return (
    <section className="card" aria-label="Guided booking">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2 style={{ margin: 0 }}>Book it yourself: step by step</h2>
        <button type="button" onClick={onClose}>Close</button>
      </div>
      <p className="muted">
        {doneCount} of {legs.length} legs marked booked · {formatDuration(it.durationMinutes)} total · plan estimate {formatInr(it.cost.expectedGroup)} for {it.cost.passengers} traveller(s)
        {paidTotal > 0 && <> · you reported paying ₹{paidTotal.toLocaleString("en-IN")}</>}
      </p>
      {demo && <div className="banner">These prices are demo estimates, not live fares. Check the real price on each official site before you pay; it may be higher or lower.</div>}
      <ul className="muted">
        <li>{new Set(legs.map((s) => s.ticketId ?? s.id)).size > 1 ? "Some legs are separate tickets. If one is cancelled or delayed, later legs are not protected, so check each refund policy before paying." : "This is one ticket, so the airline protects your connections."}</li>
        <li>Book the leg most likely to sell out first (often the train), and keep your confirmation numbers.</li>
        <li>You pay each provider directly on their site. We never take payment and cannot see or verify your bookings.</li>
      </ul>

      <ol style={{ paddingLeft: 20 }}>
        {it.segments.map((s, i) => {
          if (s.mode === "ground") {
            return (
              <li key={s.id} className="muted" style={{ margin: "10px 0" }}>
                🚕 Arrange local transfer {s.from.name} → {s.to.name} (estimate {s.fare ? formatInr(s.fare.amount) : "n/a"}; pay the driver or app directly).
              </li>
            );
          }
          const link = officialLink(s);
          const n = legs.indexOf(s) + 1;
          return (
            <li key={s.id} style={{ margin: "14px 0" }}>
              <div><strong>{ICON[s.mode]} Leg {n}: {s.from.name} → {s.to.name}</strong></div>
              <div className="muted">{s.operator} · {s.fareClass} · departs {formatLocal(s.departAt)}, arrives {formatLocal(s.arriveAt)} (local) · {s.source === "live" ? "live fare" : "demo estimate"} {s.fare && s.fare.amount === 0 && s.ticketId ? "included in the same ticket as the previous leg" : s.fare ? formatInr(s.fare.amount) + " per person" : "n/a"}</div>
              {link && (
                <p style={{ margin: "6px 0" }}>
                  <a href={link.url} target="_blank" rel="noopener noreferrer">{link.label} ↗</a>{" "}
                  <span className="muted">(opens a third-party site in a new tab)</span>
                </p>
              )}
              <div className="row">
                <label className="row" style={{ margin: 0 }}>
                  <input type="checkbox" checked={!!p.done[s.id]} onChange={(e) => save({ ...p, done: { ...p.done, [s.id]: e.target.checked } })} /> I booked this leg
                </label>
                <input aria-label={`Booking reference for leg ${n}`} placeholder="Booking ref (optional)" maxLength={40} style={{ maxWidth: 200 }}
                  value={p.ref[s.id] ?? ""} onChange={(e) => save({ ...p, ref: { ...p.ref, [s.id]: e.target.value } })} />
                <input aria-label={`Price you paid for leg ${n}`} placeholder="Paid ₹ (optional)" inputMode="numeric" maxLength={9} style={{ maxWidth: 150 }}
                  value={p.paid[s.id] ?? ""} onChange={(e) => save({ ...p, paid: { ...p.paid, [s.id]: e.target.value.replace(/[^\d]/g, "") } })} />
              </div>
            </li>
          );
        })}
      </ol>
      <div className="row">
        <span className="muted">Saved on this device only; self-reported, not verified.</span>
        <button type="button" onClick={() => save(EMPTY)}>Reset checklist</button>
      </div>
    </section>
  );
}
