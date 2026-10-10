// Times are ISO strings carrying an explicit UTC offset, so every timestamp is unambiguous and
// durations always come from epoch differences. Demo data uses each city's fixed standard offset
// (daylight saving is NOT modelled).
export const IST = 330;

export function parseTime(iso: string): number {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) throw new Error(`Invalid timestamp: ${iso}`);
  return t;
}

export function offsetString(offsetMin: number): string {
  const sign = offsetMin < 0 ? "-" : "+";
  const abs = Math.abs(offsetMin);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}

/** Format an instant as local wall-clock time at the given offset, e.g. 2026-11-15T19:40:00+05:30. */
export function toIsoOffset(epochMs: number, offsetMin: number): string {
  const d = new Date(epochMs + offsetMin * 60_000);
  return d.toISOString().replace("Z", "").replace(/\.\d{3}$/, "") + offsetString(offsetMin);
}

export const toIstIso = (epochMs: number) => toIsoOffset(epochMs, IST);

/** Epoch for a local date + HH:MM at the given offset. */
export function localEpoch(date: string, hhmm: string, offsetMin: number): number {
  return parseTime(`${date}T${hhmm}:00${offsetString(offsetMin)}`);
}
export const istEpoch = (date: string, hhmm: string) => localEpoch(date, hhmm, IST);

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function minutesBetween(aMs: number, bMs: number): number {
  return Math.round((bMs - aMs) / 60_000);
}

/** Minute-of-day at the given local offset. */
export function localMinuteOfDay(epochMs: number, offsetMin = IST): number {
  const d = new Date(epochMs + offsetMin * 60_000);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}
export const istMinuteOfDay = (epochMs: number) => localMinuteOfDay(epochMs, IST);

/** True if [startMs, endMs] overlaps 00:00–05:00 local time (at `offsetMin`) on any day. */
export function overlapsNight(startMs: number, endMs: number, offsetMin = IST): boolean {
  if (endMs <= startMs) return false;
  const DAY = 24 * 60 * 60_000;
  const offset = offsetMin * 60_000;
  let dayStart = Math.floor((startMs + offset) / DAY) * DAY - offset;
  for (; dayStart < endMs; dayStart += DAY) {
    const nightEnd = dayStart + 5 * 60 * 60_000;
    if (startMs < nightEnd && endMs > dayStart) return true;
  }
  return false;
}

export function formatDuration(minutes: number): string {
  const d = Math.floor(minutes / 1440);
  const h = Math.floor((minutes % 1440) / 60);
  const m = minutes % 60;
  return [d ? `${d}d` : "", h ? `${h}h` : "", m ? `${m}m` : ""].filter(Boolean).join(" ") || "0m";
}

/** "15 Nov, 19:40" taken straight from the local wall-clock in the ISO string (no timezone conversion). */
export function formatLocal(iso: string): string {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return iso;
  const mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][+m[2] - 1];
  return `${+m[3]} ${mon}, ${m[4]}:${m[5]}`;
}
