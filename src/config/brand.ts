// Single place to rebrand the product.
export const brand = {
  name: "RoutePilot AI",
  tagline: "Plan the whole journey — trains, flights and buses in one route.",
  supportEmail: "support@example.com", // OWNER: replace
  legalEntity: "[OWNER: legal business name]", // OWNER: replace
  androidAppId: "com.example.routepilot", // OWNER: replace before Play upload
  appScheme: "com.example.routepilot",
} as const;

export const searchConfig = {
  maxLegs: 4,
  maxLayoverMinutes: 20 * 60,
  maxTotalMinutes: 120 * 60,
  maxResults: 40,
  fareFreshnessMinutes: 15,
  providerTimeoutMs: 4000,
  // Minutes needed after arrival (deplaning) by the previous mode.
  deplaneBuffer: { flight: 20, train: 10, bus: 10, ground: 0 } as Record<string, number>,
  // Minutes needed before departure (check-in / boarding) by the next mode.
  boardingBuffer: { flight: 120, train: 45, bus: 30, ground: 0 } as Record<string, number>,
  quoteTtlMinutes: 10,
} as const;
