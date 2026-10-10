import type { Segment } from "./domain/types";

export interface OfficialLink {
  label: string;
  url: string;
}

/**
 * Outbound links only: the user opens the provider's own site to see the REAL current price and book.
 * We never scrape or automate these sites. Links carry no personal data.
 */
export function officialLink(s: Segment): OfficialLink | null {
  if (s.mode === "ground") return null;
  const date = s.departAt.slice(0, 10);
  const search = (q: string) => `https://www.google.com/search?q=${encodeURIComponent(q)}`;

  if (s.mode === "flight") {
    return {
      label: "Compare live fares on Google Flights",
      url: `https://www.google.com/travel/flights?q=${encodeURIComponent(`Flights from ${s.from.code} to ${s.to.code} on ${date}`)}`,
    };
  }
  const domestic = s.from.country === "India" && s.to.country === "India";
  if (s.mode === "train") {
    return domestic
      ? { label: "Open IRCTC (Indian Railways)", url: "https://www.irctc.co.in/nget/train-search" }
      : { label: "Search train tickets", url: search(`train tickets ${s.from.cityName} to ${s.to.cityName} ${date}`) };
  }
  return domestic
    ? { label: "Open redBus", url: "https://www.redbus.in/" }
    : { label: "Search bus tickets", url: search(`bus tickets ${s.from.cityName} to ${s.to.cityName} ${date}`) };
}
