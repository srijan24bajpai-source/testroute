"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Constraints, Itinerary, SearchResult } from "@/lib/domain/types";
import { formatInr } from "@/lib/domain/money";
import { formatDuration } from "@/lib/domain/time";
import { ItineraryCard } from "./ItineraryCard";
import { useVoice } from "./useVoice";
import { describeItinerary } from "@/lib/describe";
import { GuidedBooking } from "./GuidedBooking";
import { AssistedPlan } from "./AssistedPlan";
import { CheckoutPanel } from "./CheckoutPanel";
import { locateNearestCity } from "./geo";
import { PlaceInput } from "./PlaceInput";

type JourneyMode = "view" | "manual" | "assisted";
const JOURNEY_MODES: [JourneyMode, string, string][] = [
  ["view", "1 · Just show me", "See the best journeys, no booking"],
  ["manual", "2 · I'll book myself", "Step-by-step guide with official links"],
  ["assisted", "3 · Plan it for me", "Give start, destination and budget"],
];

function summarise(r: SearchResult): string {
  if (r.itineraries.length === 0) return "I couldn't find any routes for that. Try relaxing the budget, deadline or mode filters.";
  const by = new Map(r.itineraries.map((i) => [i.id, i]));
  const pick = (k: "fastest" | "cheapest" | "bestValue") => by.get(r.rankings[k][0])!;
  return `Found ${r.itineraries.length} options (demo data). Fastest: ${describeItinerary(pick("fastest"))}. Cheapest: ${describeItinerary(pick("cheapest"))}. Best value: ${describeItinerary(pick("bestValue"))}.`;
}

type Mode = "flight" | "train" | "bus";
type Form = {
  origin: string; destination: string; date: string; passengers: number; modes: Mode[];
  budget: string; arriveBy: string; maxTransfers: string; avoidOvernightBuses: boolean; avoidOvernightStops: boolean;
};
type ChatMsg = { from: "user" | "bot"; text: string };
type Sort = "bestValue" | "fastest" | "cheapest" | "convenient";

const SORTS: [Sort, string][] = [["bestValue", "Best value"], ["fastest", "Fastest"], ["cheapest", "Cheapest"], ["convenient", "Most convenient"]];

function defaultDate(): string {
  const d = new Date(Date.now() + 7 * 86_400_000 + 330 * 60_000);
  return d.toISOString().slice(0, 10);
}

export function Planner() {
  const [form, setForm] = useState<Form>({
    origin: "Jammu", destination: "Kanyakumari", date: defaultDate(), passengers: 1, modes: ["flight", "train", "bus"],
    budget: "", arriveBy: "", maxTransfers: "", avoidOvernightBuses: false, avoidOvernightStops: false,
  });
  const [msgs, setMsgs] = useState<ChatMsg[]>([{ from: "bot", text: 'Tell me about your trip, e.g. "Lucknow to Goa on 20 Dec for 2, under ₹8,000" or "Reykjavik to Sydney, fastest". Any city, state or airport in the world works; airport codes too (LKO, DEL, LHR).' }]);
  const [chatInput, setChatInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SearchResult | null>(null);
  const [sort, setSort] = useState<Sort>("bestValue");
  const [selected, setSelected] = useState<string | null>(null);
  const [jm, setJm] = useState<JourneyMode>("view");
  const [guide, setGuide] = useState<Itinerary | null>(null);
  const [checkoutFor, setCheckoutFor] = useState<Itinerary | null>(null);
  const [pay, setPay] = useState<{ ready: boolean; gateways: ("phonepe" | "paypal")[] }>({ ready: false, gateways: [] });
  useEffect(() => {
    fetch("/api/health").then((r) => r.json()).then((h) => {
      const gateways = (h?.features?.payments?.gateways ?? []) as ("phonepe" | "paypal")[];
      setPay({ ready: Boolean(h?.features?.liveBooking) && gateways.length > 0, gateways });
    }).catch(() => setPay({ ready: false, gateways: [] }));
  }, []);
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const from = q.get("from")?.slice(0, 80), to = q.get("to")?.slice(0, 80);
    if (from || to) setForm((f) => ({ ...f, origin: from ?? f.origin, destination: to ?? f.destination }));
  }, []);
  const [locMsg, setLocMsg] = useState<string | null>(null);
  const lastConstraints = useRef<Constraints | null>(null);

  // ---- voice: speak answers aloud (opt-in) and dictate questions with the mic
  const [voiceOut, setVoiceOut] = useState(false);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const voice = useVoice(setVoiceError);
  const spokenCount = useRef(1); // the welcome message is never auto-read
  useEffect(() => {
    if (msgs.length > spokenCount.current) {
      const last = msgs[msgs.length - 1];
      spokenCount.current = msgs.length;
      if (voiceOut && last.from === "bot") voice.speak(last.text);
    }
  }, [msgs, voiceOut, voice]);

  function toggleMic() {
    setVoiceError(null);
    if (voice.listening) return voice.stopListening();
    voice.startListening((text) => {
      setVoiceOut(true); // you spoke, so answer out loud
      void sendChat(text);
    });
  }

  const toConstraints = (f: Form, priority: Sort): Constraints => ({
    origin: f.origin, destination: f.destination, date: f.date, passengers: f.passengers, modes: f.modes,
    ...(f.budget ? { maxBudgetPerPerson: Math.round(Number(f.budget)) } : {}),
    ...(f.arriveBy ? { arriveBy: f.arriveBy } : {}),
    ...(f.maxTransfers !== "" ? { maxTransfers: Number(f.maxTransfers) } : {}),
    avoidOvernightBuses: f.avoidOvernightBuses, avoidOvernightStops: f.avoidOvernightStops, priority,
  });

  async function search(f = form, p = sort) {
    setBusy(true); setError(null); setGuide(null); setCheckoutFor(null);
    const c = toConstraints(f, p);
    lastConstraints.current = c;
    try {
      const res = await fetch("/api/search", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ constraints: c }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error?.message ?? "Search failed.");
      setResult(data as SearchResult);
      setMsgs((m) => [...m, { from: "bot", text: summarise(data as SearchResult) }]);
    } catch (e) {
      setResult(null);
      setError(e instanceof Error ? e.message : "Network error. Please retry.");
    } finally {
      setBusy(false);
    }
  }

  const ordered = useMemo(() => {
    if (!result) return [];
    const byId = new Map(result.itineraries.map((i) => [i.id, i]));
    return result.rankings[sort].map((id) => byId.get(id)!).filter(Boolean);
  }, [result, sort]);

  async function sendChat(spoken?: string) {
    const text = (spoken ?? chatInput).trim();
    if (!text) return;
    setChatInput("");
    setMsgs((m) => [...m, { from: "user", text }]);
    try {
      const res = await fetch("/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: text, constraints: lastConstraints.current ?? toConstraints(form, sort) }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error?.message ?? "Chat failed.");
      const c = data.constraints as Partial<Constraints>;
      const next: Form = {
        ...form,
        origin: c.origin ?? form.origin, destination: c.destination ?? form.destination, date: c.date ?? form.date,
        passengers: c.passengers ?? form.passengers, modes: (c.modes as Mode[] | undefined) ?? form.modes,
        budget: c.maxBudgetPerPerson ? String(c.maxBudgetPerPerson) : form.budget, arriveBy: c.arriveBy ?? form.arriveBy,
        maxTransfers: c.maxTransfers !== undefined ? String(c.maxTransfers) : form.maxTransfers,
        avoidOvernightBuses: c.avoidOvernightBuses ?? form.avoidOvernightBuses, avoidOvernightStops: c.avoidOvernightStops ?? form.avoidOvernightStops,
      };
      setForm(next);
      const a = data.action as { type: string; index?: number; priority?: Sort };
      let reply = data.reply as string;
      if (a.type === "sort" && a.priority && result) { setSort(a.priority); reply = `Showing ${SORTS.find((s) => s[0] === a.priority)?.[1].toLowerCase()} first.`; }
      else if ((a.type === "select" || a.type === "book") && a.index) {
        const it = ordered[a.index - 1];
        if (it) { setSelected(it.id); reply = a.type === "book" ? (pay.ready ? `Opening checkout for option ${a.index}. You review the exact price and confirm before anything is charged.` : `I can't buy tickets for you yet, so here's a step-by-step guide to book option ${a.index} yourself on the official sites.`) : `Selected option ${a.index}.`; if (a.type === "book") { if (pay.ready) openCheckout(it); else openGuide(it); } }
        else reply = `There is no option ${a.index} yet. Run a search first.`;
      } else if (data.ready && (a.type === "search" || a.type === "sort")) { reply = "Searching with: " + summary(next); void search(next, (c.priority as Sort) ?? sort); }
      setMsgs((m) => [...m, { from: "bot", text: reply }]);
    } catch (e) {
      setMsgs((m) => [...m, { from: "bot", text: e instanceof Error ? e.message : "Something went wrong." }]);
    }
  }

  function openCheckout(it: Itinerary) {
    setJm("manual");
    setGuide(null);
    setCheckoutFor(it);
    setTimeout(() => document.getElementById("guide-anchor")?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
  }

  function openGuide(it: Itinerary) {
    setJm("manual");
    setGuide(it);
    setTimeout(() => document.getElementById("guide-anchor")?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
  }

  async function useMyLocation() {
    setLocMsg("Finding your location…");
    try {
      const { label, km } = await locateNearestCity();
      setForm((f) => ({ ...f, origin: label }));
      setLocMsg(km <= 60 ? `Starting from ${label}.` : `Nearest large city is ${label} (about ${km} km away). Change it if that's wrong.`);
    } catch (e) {
      setLocMsg(e instanceof Error ? e.message : "Couldn't get your location.");
    }
  }

  const summary = (f: Form) =>
    `${f.origin} → ${f.destination} on ${f.date}, ${f.passengers} traveller${f.passengers > 1 ? "s" : ""}, ${f.modes.join("/")}` +
    (f.budget ? `, ≤ ${formatInr(Number(f.budget) * 100)} pp` : "") + (f.arriveBy ? `, arrive by ${f.arriveBy.replace("T", " ")}` : "");

  const toggleMode = (m: Mode) => setForm((f) => ({ ...f, modes: f.modes.includes(m) ? (f.modes.length > 1 ? f.modes.filter((x) => x !== m) : f.modes) : [...f.modes, m] }));

  return (
    <>
      <h1>Plan the whole journey</h1>
      <p className="muted">Trains, flights and buses combined into complete routes, ranked by time, cost and convenience.</p>

      <div className="modes" role="tablist" aria-label="How do you want to travel with us?">
        {JOURNEY_MODES.map(([k, title, sub]) => (
          <button key={k} type="button" role="tab" aria-selected={jm === k} className={jm === k ? "tab on" : "tab"} onClick={() => { setJm(k); if (k !== "manual") setGuide(null); }}>
            <strong>{title}</strong><span>{sub}</span>
          </button>
        ))}
      </div>

      {jm === "assisted" ? <AssistedPlan onGuide={openGuide} /> : (<>
      <section className="card" aria-label="Chat">
        <div className="chat" role="log" aria-live="polite">{msgs.map((m, i) => <div key={i} className={`msg ${m.from}`}>{m.text}</div>)}</div>
        <form className="row" onSubmit={(e) => { e.preventDefault(); void sendChat(); }}>
          <label htmlFor="chat" className="skip">Message</label>
          {voice.sttSupported && (
            <button type="button" className={`mic${voice.listening ? " live" : ""}`} onClick={toggleMic} aria-pressed={voice.listening}
              aria-label={voice.listening ? "Stop listening" : "Speak your question"} title={voice.listening ? "Stop listening" : "Speak your question"}>
              {voice.listening ? "⏹" : "🎤"}
            </button>
          )}
          <input id="chat" style={{ flex: 1, minWidth: 200 }} value={voice.listening ? voice.interim : chatInput} readOnly={voice.listening} maxLength={500}
            onChange={(e) => setChatInput(e.target.value)}
            placeholder={voice.listening ? "Listening… speak now" : "e.g. show me the cheapest option under ₹8,000"} />
          <button className="primary" type="submit" disabled={voice.listening}>Send</button>
          {voice.ttsSupported && (
            <button type="button" aria-pressed={voiceOut} className={voiceOut ? "on" : ""}
              onClick={() => { if (voiceOut) voice.stopSpeaking(); setVoiceOut(!voiceOut); }}
              title="Read answers aloud">{voiceOut ? "🔊 Voice on" : "🔈 Voice off"}</button>
          )}
          {voice.speaking && <button type="button" onClick={voice.stopSpeaking}>Stop</button>}
        </form>
        <div aria-live="polite" className="muted">
          {voice.listening && "🎙 Listening…"}
          {voiceError && <span className="err">{voiceError}</span>}
          {!voice.sttSupported && <span> Voice input isn&apos;t available in this browser (try Chrome or Edge); you can still type.</span>}
        </div>
      </section>

      <form className="card" onSubmit={(e) => { e.preventDefault(); void search(); }} aria-label="Trip constraints">
        <div className="grid">
          <div><label htmlFor="o">From</label><PlaceInput id="o" required value={form.origin} onChange={(v) => setForm({ ...form, origin: v })} />
            <button type="button" onClick={useMyLocation} style={{ marginTop: 6 }}>📍 Use my location</button></div>
          <div><label htmlFor="d">To</label><PlaceInput id="d" required value={form.destination} onChange={(v) => setForm({ ...form, destination: v })} /></div>
          <div><label htmlFor="dt">Date</label><input id="dt" type="date" required value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} /></div>
          <div><label htmlFor="p">Passengers</label><input id="p" type="number" min={1} max={9} value={form.passengers} onChange={(e) => setForm({ ...form, passengers: Math.min(9, Math.max(1, Number(e.target.value) || 1)) })} /></div>
          <div><label htmlFor="b">Budget per person (₹)</label><input id="b" type="number" min={1} inputMode="numeric" value={form.budget} onChange={(e) => setForm({ ...form, budget: e.target.value })} /></div>
          <div><label htmlFor="a">Arrive by (local time at destination)</label><input id="a" type="datetime-local" value={form.arriveBy} onChange={(e) => setForm({ ...form, arriveBy: e.target.value })} /></div>
          <div><label htmlFor="t">Max changes</label>
            <select id="t" value={form.maxTransfers} onChange={(e) => setForm({ ...form, maxTransfers: e.target.value })}><option value="">Any</option><option value="0">Direct only</option><option value="1">1</option><option value="2">2</option><option value="3">3</option></select></div>
        </div>
        <div className="row chips" style={{ marginTop: 12 }} role="group" aria-label="Modes">
          {(["flight", "train", "bus"] as Mode[]).map((m) => <button type="button" key={m} aria-pressed={form.modes.includes(m)} onClick={() => toggleMode(m)}>{m === "flight" ? "✈ Flights" : m === "train" ? "🚆 Trains" : "🚌 Buses"}</button>)}
          <label className="row" style={{ margin: 0 }}><input type="checkbox" style={{ width: "auto" }} checked={form.avoidOvernightBuses} onChange={(e) => setForm({ ...form, avoidOvernightBuses: e.target.checked })} /> Avoid overnight buses</label>
          <label className="row" style={{ margin: 0 }}><input type="checkbox" style={{ width: "auto" }} checked={form.avoidOvernightStops} onChange={(e) => setForm({ ...form, avoidOvernightStops: e.target.checked })} /> Avoid overnight waits</label>
        </div>
        <p className="muted">Summary: {summary(form)}</p>
        {locMsg && <p className="muted" role="status">{locMsg}</p>}
        <button className="primary" type="submit" disabled={busy}>{busy ? "Searching…" : "Search routes"}</button>
      </form>

      {error && <p className="err" role="alert">{error} <button type="button" onClick={() => void search()}>Retry</button></p>}
      {busy && <><div className="skeleton" /><div className="skeleton" /></>}

      {result && !busy && (
        <section aria-label="Results">
          {result.dataLabel !== "live" && result.itineraries.length > 0 && <div className="banner" role="status">Demo data — not live availability or a bookable fare. Schedules and prices are generated from distances, shown in ₹, and daylight-saving time is not modelled.</div>}
          {result.partial && <div className="banner" role="status">Some providers did not respond ({result.providers.filter((p) => !p.ok).map((p) => `${p.providerId}: ${p.error}`).join(", ")}). Results may be incomplete.</div>}
          <div className="row chips" role="group" aria-label="Sort">
            {SORTS.map(([k, l]) => <button key={k} type="button" aria-pressed={sort === k} onClick={() => setSort(k)}>{l}</button>)}
          </div>
          {ordered.length === 0 && <div className="card">No itinerary matched. {result.notes.filter((n) => !n.startsWith("Best-value")).join(" ")}</div>}
          {ordered.slice(0, 12).map((it, i) => (
            <ItineraryCard key={it.id} it={it} rank={i + 1} why={result.explanations[it.id] ?? []} selected={selected === it.id} mode={jm === "manual" ? "manual" : "view"} onSelect={(x) => setSelected(x.id)} onGuide={openGuide} onPay={pay.ready ? openCheckout : undefined} />
          ))}
          <p className="muted">{result.notes.find((n) => n.startsWith("Best-value"))}</p>
          {result.charter && result.charter.length > 0 && (
            <section className="card" aria-label="Other ways to travel">
              <h2 style={{ marginTop: 0 }}>Other ways to travel · price on request</h2>
              <p className="muted">No public price feed exists for these, so we do not show a fare. Ask operators for a quote. Ferries and sea routes are not covered.</p>
              {result.charter.map((c) => (
                <div key={c.mode} style={{ margin: "12px 0" }}>
                  <strong>{c.mode === "private_jet" ? "✈ Private jet" : c.mode === "helicopter" ? "🚁 Helicopter" : "🛩 Seaplane"}</strong>
                  <span className="badge est" style={{ marginLeft: 8 }}>Price on request</span>
                  <div className="muted">{c.fromSite} → {c.toSite} · about {c.distanceKm.toLocaleString("en-IN")} km</div>
                  <div className="muted">{c.note}</div>
                  <a href={c.link.url} target="_blank" rel="noopener noreferrer">{c.link.label} ↗</a>
                </div>
              ))}
            </section>
          )}
        </section>
      )}

      </>)}
      <div id="guide-anchor" />
      {guide && <GuidedBooking it={guide} onClose={() => setGuide(null)} />}
      {checkoutFor && lastConstraints.current && <CheckoutPanel it={checkoutFor} constraints={lastConstraints.current} gateways={pay.gateways} />}
    </>
  );
}
