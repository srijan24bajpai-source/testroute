"use client";
import { useState } from "react";
import type { Itinerary } from "@/lib/domain/types";
import { formatInr } from "@/lib/domain/money";
import { formatDuration, formatLocal } from "@/lib/domain/time";
import { officialLink } from "@/lib/links";

const fmt = formatLocal; // local wall-clock time at each place, taken from the timestamp itself

const ICON = { flight: "✈", train: "🚆", bus: "🚌", ground: "🚕" } as const;

export function SourceBadge({ source, stale, estimated }: { source: Itinerary["source"]; stale?: boolean; estimated?: boolean }) {
  return (
    <span className="row">
      {source !== "live" && <span className="badge demo">Demo</span>}
      {source === "live" && <span className="badge live">Live</span>}
      {estimated && <span className="badge est">Includes estimates</span>}
      {stale && <span className="badge stale">Stale</span>}
    </span>
  );
}

export function ItineraryCard(props: {
  it: Itinerary;
  rank: number;
  why: string[];
  mode: "view" | "manual";
  onGuide: (it: Itinerary) => void;
  /** Set only when a live booking provider AND a payment gateway are configured. */
  onPay?: (it: Itinerary) => void;
  onSelect: (it: Itinerary) => void;
  selected: boolean;
}) {
  const { it, rank, why } = props;
  const [open, setOpen] = useState(false);
  const c = it.cost;
  return (
    <article className="card" aria-label={`Option ${rank}`} style={props.selected ? { outline: "3px solid var(--brand)" } : undefined}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <strong>Option {rank}</strong>
        <SourceBadge source={it.source} stale={it.stale} estimated={c.estimatedPerPerson > 0} />
      </div>
      <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-end" }}>
        <div>
          <div className="price">{formatInr(c.expectedPerPerson)} <span className="muted">per person</span></div>
          <div className="muted">
            {c.passengers > 1 && <>Group of {c.passengers}: {formatInr(c.expectedGroup)} · </>}
            {c.estimatedPerPerson > 0 && <>range {formatInr(c.lowPerPerson)}–{formatInr(c.highPerPerson)} · </>}
            {c.unknownComponents > 0 && <>some prices unknown · </>}
            fares {c.confidence === "quoted" ? "quoted" : "partly estimated"}
          </div>
        </div>
        <div style={{ textAlign: "right" }}>
          <strong>{formatDuration(it.durationMinutes)}</strong>
          <div className="muted">{it.transfers} change{it.transfers === 1 ? "" : "s"}</div>
        </div>
      </div>
      <div className="muted">Departs {fmt(it.departAt)} · arrives {fmt(it.arriveAt)} (local time at each end)</div>
      <div className="row" style={{ marginTop: 6 }}>
        {why.filter((w) => w.startsWith("#")).map((w) => <span key={w} className="badge">{w}</span>)}
      </div>
      <ol className="timeline" aria-label="Route timeline">
        {it.segments.map((s, i) => {
          const conn = it.connections.find((x) => x.toSegmentId === s.id || (s.mode === "ground" && x.fromSegmentId === it.segments[i - 1]?.id));
          return (
            <li key={s.id} className={s.mode === "ground" ? "ground" : ""}>
              <strong>{ICON[s.mode]} {s.from.name} → {s.to.name}</strong>
              <div className="muted">
                {s.operator} · {s.fareClass} · {fmt(s.departAt)} → {fmt(s.arriveAt)} ·{" "}
                {s.fare && s.fare.amount === 0 && s.ticketId ? "included in the same ticket" : s.fare ? `${formatInr(s.fare.amount)}${s.fareKind === "estimated" ? " (estimate)" : ""}` : "price unknown"}
              </div>
              {(() => {
                const link = officialLink(s);
                return link ? (
                  <div className="muted">
                    <a href={link.url} target="_blank" rel="noopener noreferrer">Check the real current price: {link.label} ↗</a>
                  </div>
                ) : null;
              })()}
              {conn && s.mode !== "ground" && i > 0 && it.segments[i - 1].mode !== "ground" && (
                <div className={conn.overnight ? "err" : "muted"}>Wait {formatDuration(conn.waitMinutes)}{conn.overnight ? " (overnight)" : ""}</div>
              )}
            </li>
          );
        })}
      </ol>
      {it.flags.length > 0 && (
        <ul className="flags">
          {it.flags.map((f) => <li key={f}>⚠ {f}</li>)}
        </ul>
      )}
      <div className="row">
        <button type="button" onClick={() => setOpen(!open)} aria-expanded={open}>{open ? "Hide" : "Why this rank & cost details"}</button>
        <button type="button" onClick={() => props.onSelect(it)}>{props.selected ? "Selected" : "Select"}</button>
        {props.mode === "manual" && props.onPay && <button type="button" className="primary" onClick={() => props.onPay!(it)}>Pay &amp; book this</button>}
        {props.mode === "manual" && <button type="button" className={props.onPay ? "" : "primary"} onClick={() => props.onGuide(it)}>Guide me to book this</button>}
      </div>
      {open && (
        <div>
          <h2>Why this ranking</h2>
          <ul>{why.map((w) => <li key={w}>{w}</li>)}</ul>
          <h2>Cost breakdown (per person)</h2>
          <table>
            <tbody>
              {c.components.map((x) => (
                <tr key={x.segmentId}>
                  <td>{x.label}</td>
                  <td>{x.kind}</td>
                  <td>{x.perPerson === null ? "unknown" : formatInr(x.perPerson)}{x.kind === "estimated" && x.low !== null && x.high !== null ? ` (${formatInr(x.low)}–${formatInr(x.high)})` : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <ul className="muted">{c.assumptions.map((a) => <li key={a}>{a}</li>)}</ul>
          <div className="muted">Data fetched {new Date(it.oldestFetchedAt).toLocaleString()} (your device time).</div>
        </div>
      )}
    </article>
  );
}
