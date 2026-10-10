"use client";
import { useEffect, useRef, useState } from "react";
import type { Constraints, Itinerary, SearchResult } from "@/lib/domain/types";
import { formatInr } from "@/lib/domain/money";
import { describeItinerary, parseSpokenAmount } from "@/lib/describe";
import { ItineraryCard } from "./ItineraryCard";
import { locateNearestCity } from "./geo";
import { PlaceInput } from "./PlaceInput";
import { useVoice } from "./useVoice";
import { CheckoutPanel } from "./CheckoutPanel";

type Priority = "bestValue" | "fastest" | "cheapest" | "convenient";
type Values = { origin: string; destination: string; date: string; passengers: number; budget: string; priority: Priority };
type Plan = { it: Itinerary; why: string[]; over: number; note: string; label: SearchResult["dataLabel"] };

function defaultDate(): string {
  return new Date(Date.now() + 7 * 86_400_000 + 330 * 60_000).toISOString().slice(0, 10);
}

/**
 * "Plan it for me": the traveller gives a start (typed, spoken, or from their location), a destination and a
 * budget. We pick the best itinerary inside the budget. Buying tickets needs an authorised booking connection;
 * when none is configured we say so plainly and hand the plan to the guided manual flow. Nothing is purchased,
 * no payment is requested, and no ticket is simulated.
 */
export function AssistedPlan({ onGuide }: { onGuide: (it: Itinerary) => void }) {
  const [origin, setOrigin] = useState("");
  const [destination, setDestination] = useState("");
  const [date, setDate] = useState(defaultDate());
  const [passengers, setPassengers] = useState(1);
  const [budget, setBudget] = useState("");
  const [priority, setPriority] = useState<Priority>("bestValue");
  const [locMsg, setLocMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [liveBooking, setLiveBooking] = useState<boolean | null>(null);
  const [gateways, setGateways] = useState<("phonepe" | "paypal")[]>([]);
  const lastConstraints = useRef<Partial<Constraints>>({});

  // ---- voice
  const [voiceMsg, setVoiceMsg] = useState<string | null>(null);
  const [voiceErr, setVoiceErr] = useState<string | null>(null);
  const [awaitBudget, setAwaitBudget] = useState(false);
  const voice = useVoice(setVoiceErr);

  useEffect(() => {
    fetch("/api/health").then((r) => r.json()).then((h) => { setLiveBooking(Boolean(h?.features?.liveBooking)); setGateways(h?.features?.payments?.gateways ?? []); }).catch(() => setLiveBooking(false));
  }, []);

  async function useLocation() {
    setLocMsg("Finding your location…");
    try {
      const { label, km } = await locateNearestCity();
      setOrigin(label);
      setLocMsg(km <= 60 ? `Starting from ${label}.` : `Nearest large city is ${label} (about ${km} km away). Change it if that's wrong.`);
    } catch (e) {
      setLocMsg(e instanceof Error ? e.message : "Couldn't get your location.");
    }
  }

  async function run(v: Values, extra: Partial<Constraints>) {
    const constraints = { origin: v.origin, destination: v.destination, date: v.date, passengers: v.passengers, priority: v.priority, ...extra };
    lastConstraints.current = constraints;
    const res = await fetch("/api/search", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ constraints }) });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error?.message ?? "Search failed.");
    return data as SearchResult;
  }

  /** Pick the best itinerary inside the budget; returns what to say aloud. */
  async function planWith(v: Values): Promise<string> {
    setBusy(true); setError(null); setPlan(null);
    try {
      const total = Math.round(Number(v.budget));
      const within = await run(v, { maxBudgetPerPerson: Math.floor(total / v.passengers) });
      if (within.itineraries.length > 0) {
        const it = new Map(within.itineraries.map((i) => [i.id, i])).get(within.rankings[v.priority][0])!;
        setPlan({ it, why: within.explanations[it.id] ?? [], over: 0, label: within.dataLabel, note: `Best ${v.priority === "bestValue" ? "value" : v.priority} option within your ${formatInr(total * 100)} budget.` });
        return `Best option within your budget: ${describeItinerary(it)}. This is demo data, and automatic booking isn't switched on yet, but I can guide you to book it yourself.`;
      }
      const any = await run(v, {});
      if (any.itineraries.length === 0) throw new Error("No routes found for that trip. Try other dates or places.");
      const cheapest = new Map(any.itineraries.map((i) => [i.id, i])).get(any.rankings.cheapest[0])!;
      const over = Math.max(0, cheapest.cost.expectedGroup - total * 100);
      setPlan({ it: cheapest, why: any.explanations[cheapest.id] ?? [], label: any.dataLabel, over, note: "Nothing fits your budget. This is the cheapest option found." });
      return `Nothing fits that budget. The cheapest option is ${describeItinerary(cheapest)}, about ${formatInr(over)} over.`;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Something went wrong.";
      setError(msg);
      return msg;
    } finally {
      setBusy(false);
    }
  }

  const current = (): Values => ({ origin, destination, date, passengers, budget, priority });

  function submit(e: React.FormEvent) {
    e.preventDefault();
    void planWith(current());
  }

  // ---- voice conversation: fill the form from speech, ask for what's missing, then plan
  function say(text: string) {
    setVoiceMsg(text);
    voice.speak(text);
  }

  async function onSpeech(text: string) {
    setVoiceErr(null);
    let v = current();
    try {
      if (awaitBudget) {
        const amount = parseSpokenAmount(text);
        if (!amount) return say("Sorry, I didn't catch an amount. Please say your total budget in rupees, for example 15,000.");
        v = { ...v, budget: String(amount) };
        setBudget(v.budget);
        setAwaitBudget(false);
      } else {
        const have: Record<string, unknown> = { passengers: v.passengers };
        if (v.origin) have.origin = v.origin;
        if (v.destination) have.destination = v.destination;
        const res = await fetch("/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: text, constraints: have }) });
        const data = await res.json();
        if (!res.ok) return say(data?.error?.message ?? "Sorry, something went wrong. Please try again.");
        const c = data.constraints as Partial<Constraints>;
        v = {
          origin: c.origin ?? v.origin,
          destination: c.destination ?? v.destination,
          date: c.date ?? v.date,
          passengers: c.passengers ?? v.passengers,
          priority: (c.priority as Priority | undefined) ?? v.priority,
          // In this mode a spoken budget means the total for everyone.
          budget: c.maxBudgetPerPerson ? String(c.maxBudgetPerPerson) : v.budget,
        };
        setOrigin(v.origin); setDestination(v.destination); setDate(v.date); setPassengers(v.passengers); setPriority(v.priority); setBudget(v.budget);
        if (/couldn't find/.test(String(data.reply))) return say(String(data.reply));
      }
      if (!v.origin) return say("Where are you starting from? Say a city, or tap Use my location.");
      if (!v.destination) return say("Where do you want to go?");
      if (!v.budget) {
        setAwaitBudget(true);
        return say("What is your total budget for everyone, in rupees?");
      }
      setVoiceMsg(`Planning ${v.origin} to ${v.destination} with a budget of ${formatInr(Number(v.budget) * 100)}…`);
      say(await planWith(v));
    } catch {
      say("Sorry, I couldn't reach the server. Please try again.");
    }
  }

  function toggleMic() {
    setVoiceErr(null);
    if (voice.listening) return voice.stopListening();
    voice.startListening((text) => {
      setVoiceMsg(`You said: “${text}”`);
      void onSpeech(text);
    });
  }

  return (
    <>
      <form className="card" onSubmit={submit} aria-label="Plan it for me">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h2 style={{ margin: 0 }}>Tell us where, when and how much</h2>
          {voice.sttSupported && (
            <button type="button" className={`primary${voice.listening ? " listening" : ""}`} onClick={toggleMic} aria-pressed={voice.listening}>
              {voice.listening ? "⏹ Stop listening" : "🎤 Say your trip"}
            </button>
          )}
        </div>
        <div aria-live="polite" className="muted" style={{ minHeight: 24, marginTop: 6 }}>
          {voice.listening ? `🎙 Listening… ${voice.interim}` : voiceMsg}
          {voiceErr && <span className="err"> {voiceErr}</span>}
          {voice.speaking && <> <button type="button" onClick={voice.stopSpeaking}>Stop voice</button></>}
        </div>
        {voice.sttSupported ? (
          <p className="muted">Try: “Lucknow to Goa for 2, budget 15,000”. I&apos;ll ask for anything missing, then plan it. Tap the mic again each time to answer.</p>
        ) : (
          <p className="muted">Voice input isn&apos;t available in this browser (try Chrome or Edge); you can fill the form instead.</p>
        )}
        <div className="grid">
          <div>
            <label htmlFor="ao">Start</label>
            <PlaceInput id="ao" required value={origin} onChange={setOrigin} placeholder="Any city, state or airport" />
            <button type="button" onClick={useLocation} style={{ marginTop: 6 }}>📍 Use my location</button>
          </div>
          <div><label htmlFor="ad">Destination</label><PlaceInput id="ad" required value={destination} onChange={setDestination} /></div>
          <div><label htmlFor="adt">Travel date</label><input id="adt" type="date" required value={date} onChange={(e) => setDate(e.target.value)} /></div>
          <div><label htmlFor="ap">Travellers</label><input id="ap" type="number" min={1} max={9} value={passengers} onChange={(e) => setPassengers(Math.min(9, Math.max(1, Number(e.target.value) || 1)))} /></div>
          <div><label htmlFor="ab">Total budget for everyone (₹)</label><input id="ab" type="number" required min={1} inputMode="numeric" value={budget} onChange={(e) => setBudget(e.target.value)} /></div>
          <div><label htmlFor="apr">I care most about</label>
            <select id="apr" value={priority} onChange={(e) => setPriority(e.target.value as Priority)}>
              <option value="bestValue">Best value</option><option value="cheapest">Lowest price</option><option value="fastest">Fastest</option><option value="convenient">Fewest hassles</option>
            </select></div>
        </div>
        <p className="muted" role="status">{locMsg ?? "Your location is used once, on your device, only to pick the nearest city. It is never sent to us or stored."}</p>
        <button className="primary" type="submit" disabled={busy}>{busy ? "Planning…" : "Plan my trip"}</button>
      </form>

      {error && <p className="err" role="alert">{error}</p>}
      {busy && <div className="skeleton" />}

      {plan && !busy && (
        <>
          <section className="card" aria-label="Your plan">
            <h2 style={{ marginTop: 0 }}>Your plan</h2>
            <p>{plan.note}</p>
            {plan.over > 0 && <p className="err">About {formatInr(plan.over)} over your budget.</p>}
            {plan.label !== "live" && <div className="banner">Demo data: not live availability or a bookable fare. Real prices will differ.</div>}
          </section>
          <ItineraryCard it={plan.it} rank={1} why={plan.why} selected mode="view" onSelect={() => {}} onGuide={onGuide} />

          <section className="card" aria-label="Booking status">
            <h2 style={{ marginTop: 0 }}>Booking</h2>
            {liveBooking && gateways.length > 0 ? (
              <CheckoutPanel it={plan.it} constraints={lastConstraints.current} gateways={gateways} />
            ) : liveBooking ? (
              <p>A booking connection is configured, but no payment method is enabled yet. Use the guided flow below.</p>
            ) : (
              <>
                <div className="banner">Automatic booking and UPI payment aren&apos;t switched on for this site. No ticket has been bought and nothing has been charged.</div>
                <p className="muted">Buying tickets for you requires official booking connections with the airlines, Indian Railways (IRCTC) and bus operators, and a verified payment step. Those agreements aren&apos;t in place yet, and we don&apos;t automate other companies&apos; websites. Until then, you can book this exact plan yourself with the guided checklist.</p>
              </>
            )}
            <button type="button" className="primary" onClick={() => onGuide(plan.it)}>Book this plan myself, step by step</button>
          </section>
        </>
      )}
    </>
  );
}
