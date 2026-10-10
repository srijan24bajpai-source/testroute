import { POPULAR_ROUTES, slugOf } from "@/lib/seo/routes";
import type { MetadataRoute } from "next";

const origin = process.env.APP_ORIGIN || "https://airoutepilot.vercel.app";

export default function sitemap(): MetadataRoute.Sitemap {
  return ["", ...POPULAR_ROUTES.map(([a, b]) => `/routes/${slugOf(a, b)}`), "/privacy", "/terms"].map((p) => ({ url: `${origin}${p}`, changeFrequency: "monthly", priority: p === "" ? 1 : p.startsWith("/routes") ? 0.7 : 0.3 }));
}
