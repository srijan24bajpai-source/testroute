// Real (daylight-saving-aware) time-zone maths for LIVE data, where airlines give local times plus an IANA zone.
// (Demo data uses one fixed standard offset per place; see geo/data.ts.)

/** Offset of `tz` from UTC, in minutes, at the given instant. */
export function tzOffsetAt(tz: string, epochMs: number): number {
  const part = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "longOffset" })
    .formatToParts(new Date(epochMs))
    .find((p) => p.type === "timeZoneName")?.value ?? "GMT";
  const m = part.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
  return m ? (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] ?? 0)) : 0;
}

/** Convert a local wall-clock time ("2026-11-15T07:05:00" or "...T07:05") in `tz` to an epoch. */
export function zonedEpoch(localIso: string, tz: string): number {
  const base = localIso.replace(/Z$/, "");
  const asUtc = Date.parse((base.length === 16 ? base + ":00" : base) + "Z");
  if (Number.isNaN(asUtc)) throw new Error(`Invalid local time: ${localIso}`);
  let guess = asUtc - tzOffsetAt(tz, asUtc) * 60_000;
  guess = asUtc - tzOffsetAt(tz, guess) * 60_000; // second pass settles times next to a DST change
  return guess;
}
