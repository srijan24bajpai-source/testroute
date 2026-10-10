"use client";
import { useEffect, useId, useRef, useState } from "react";

type Suggestion = { id: string; label: string; kind: "city" | "state" | "airport" };

/** Text input with worldwide autocomplete (cities, states/regions, airports) served by /api/places. */
export function PlaceInput({ id, value, onChange, placeholder, required }: { id: string; value: string; onChange: (v: string) => void; placeholder?: string; required?: boolean }) {
  const listId = useId();
  const [items, setItems] = useState<Suggestion[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seq = useRef(0);

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    const q = value.trim();
    if (q.length < 2) { setItems([]); return; }
    timer.current = setTimeout(async () => {
      const mine = ++seq.current;
      try {
        const res = await fetch(`/api/places?q=${encodeURIComponent(q)}&limit=8`);
        if (!res.ok) return;
        const data = (await res.json()) as { places: Suggestion[] };
        if (mine === seq.current) setItems(data.places);
      } catch {
        /* suggestions are optional; typing still works */
      }
    }, 200);
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [value]);

  return (
    <>
      <input id={id} list={listId} required={required} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder ?? "Any city, state or airport"} autoComplete="off" maxLength={120} />
      <datalist id={listId}>
        {items.map((s) => <option key={s.id} value={s.label} />)}
      </datalist>
    </>
  );
}
