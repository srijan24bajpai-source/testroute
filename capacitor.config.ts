import type { CapacitorConfig } from "@capacitor/cli";

/**
 * The Android app is a thin native shell around the deployed Next.js site (server.url), because the
 * app needs server-side routes (auth, search, booking) that cannot be statically exported.
 * Secrets never ship in the app: it contains only the public site URL.
 *
 * Set CAP_SERVER_URL to your production HTTPS origin before `npx cap sync android`.
 */
const serverUrl = process.env.CAP_SERVER_URL ?? "https://YOUR-DOMAIN.example";

const config: CapacitorConfig = {
  appId: "com.example.routepilot", // OWNER: replace (must match brand.ts, assetlinks and Play Console)
  appName: "RoutePilot AI",
  webDir: "cap-www", // offline fallback page only
  server: {
    url: serverUrl,
    cleartext: false,
    allowNavigation: [new URL(serverUrl).host, "*.supabase.co"],
  },
  android: {
    allowMixedContent: false,
    webContentsDebuggingEnabled: false,
  },
};

export default config;
