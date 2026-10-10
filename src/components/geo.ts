"use client";

export interface Located {
  label: string;
  km: number;
}

const rad = Math.PI / 180;
function km(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const h = Math.sin(((lat2 - lat1) * rad) / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(((lon2 - lon1) * rad) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

/**
 * Ask the browser for the user's position ONCE (only after they tap the button) and map it to the nearest large city
 * (a small ~100 KB list loaded on demand). The coordinates never leave the device and are not stored.
 */
export async function locateNearestCity(): Promise<Located> {
  if (!("geolocation" in navigator)) throw new Error("Location isn't available in this browser.");
  const pos = await new Promise<GeolocationPosition>((resolve, reject) =>
    navigator.geolocation.getCurrentPosition(resolve, (err) =>
      reject(new Error(err.code === err.PERMISSION_DENIED
        ? "Location permission was denied. You can type your starting place instead."
        : "Couldn't get your location. You can type your starting place instead.")),
    { enableHighAccuracy: false, timeout: 10_000, maximumAge: 5 * 60_000 }),
  );
  const { default: cities } = (await import("@/data/major-cities.json")) as unknown as { default: [string, number, number][] };
  const { latitude, longitude } = pos.coords;
  let best: Located = { label: cities[0][0], km: Infinity };
  for (const [label, lat, lon] of cities) {
    const d = km(latitude, longitude, lat, lon);
    if (d < best.km) best = { label, km: Math.round(d) };
  }
  return best;
}
