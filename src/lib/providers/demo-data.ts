import type { Mode } from "../domain/types";

/** Synthetic timetable. NOT real schedules or fares. Times are IST, services run daily. */
export interface DemoService {
  mode: Exclude<Mode, "ground">;
  from: string;
  to: string;
  dep: string; // HH:MM
  durMin: number;
  fareInr: number;
  operator: string;
  cls: string;
}

const F = (from: string, to: string, dep: string, durMin: number, fareInr: number): DemoService => ({
  mode: "flight", from, to, dep, durMin, fareInr, operator: "Demo Air", cls: "Economy",
});
const T = (from: string, to: string, dep: string, durMin: number, fareInr: number, cls = "3A"): DemoService => ({
  mode: "train", from, to, dep, durMin, fareInr, operator: "Demo Rail", cls,
});
const B = (from: string, to: string, dep: string, durMin: number, fareInr: number, cls = "AC Seater"): DemoService => ({
  mode: "bus", from, to, dep, durMin, fareInr, operator: "Demo Bus Lines", cls,
});

const forward: DemoService[] = [
  F("IXJ", "DEL", "06:30", 80, 4800), F("IXJ", "DEL", "13:15", 85, 6200),
  F("DEL", "TRV", "05:45", 220, 8900), F("DEL", "TRV", "11:20", 225, 9800), F("DEL", "TRV", "18:40", 230, 7600),
  F("DEL", "MAA", "06:00", 170, 5400), F("DEL", "MAA", "15:30", 175, 6100),
  F("DEL", "BLR", "07:10", 175, 5900), F("DEL", "BLR", "19:00", 180, 5200),
  F("DEL", "BOM", "08:00", 130, 4900),
  F("MAA", "TRV", "09:00", 100, 3800), F("MAA", "TRV", "17:45", 105, 3300),
  F("MAA", "IXM", "08:30", 65, 2900), F("MAA", "IXM", "18:00", 65, 3100),
  F("BLR", "TRV", "10:00", 85, 3100), F("BLR", "TRV", "20:15", 90, 2900),
  F("BLR", "IXM", "11:00", 70, 2700),
  F("BOM", "TRV", "12:30", 125, 4600),

  T("JAT", "NDLS", "19:40", 600, 1450, "3A"), T("JAT", "NDLS", "21:30", 570, 2350, "2A"),
  T("NDLS", "CAPE", "11:00", 3000, 2100, "3A"),
  T("NDLS", "TVC", "20:00", 2900, 2520, "3A"),
  T("NDLS", "MAS", "22:30", 1740, 2300, "3A"), T("NDLS", "MAS", "06:15", 1980, 2150, "3A"),
  T("NDLS", "SBC", "20:50", 2000, 2200, "3A"),
  T("MAS", "CAPE", "17:40", 840, 900, "SL"),
  T("MAS", "NCJ", "19:00", 780, 850, "SL"),
  T("TVC", "CAPE", "07:00", 140, 140, "2S"), T("TVC", "CAPE", "15:30", 150, 150, "2S"),
  T("NCJ", "CAPE", "08:30", 40, 35, "2S"), T("NCJ", "CAPE", "16:10", 40, 35, "2S"),
  T("SBC", "NCJ", "19:10", 1080, 1000, "SL"),
  T("MDU", "CAPE", "06:30", 270, 190, "2S"),

  B("JMBUS", "DLBUS", "17:00", 720, 1100, "AC Sleeper"),
  B("TVBUS", "KKBUS", "08:00", 120, 130), B("TVBUS", "KKBUS", "12:00", 120, 130), B("TVBUS", "KKBUS", "17:00", 130, 140),
  B("MDBUS", "KKBUS", "09:00", 260, 280), B("MDBUS", "KKBUS", "16:00", 260, 280),
  B("CHBUS", "KKBUS", "18:30", 840, 1100, "AC Sleeper"),
  B("BLBUS", "KKBUS", "19:00", 1080, 1500, "AC Sleeper"),
];

function shift(hhmm: string, minutes: number): string {
  const [h, m] = hhmm.split(":").map(Number);
  const t = (h * 60 + m + minutes + 1440) % 1440;
  return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
}

// Reverse direction with slightly different times so return trips exist.
const reverse: DemoService[] = forward.map((s) => ({
  ...s, from: s.to, to: s.from, dep: shift(s.dep, 45), fareInr: Math.round(s.fareInr * 1.03),
}));

export const DEMO_SERVICES: DemoService[] = [...forward, ...reverse];
