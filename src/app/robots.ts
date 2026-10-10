import type { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  return { rules: [{ userAgent: "*", allow: ["/", "/routes", "/privacy", "/terms"], disallow: ["/api/", "/dashboard", "/account", "/auth/"] }], sitemap: `${process.env.APP_ORIGIN || "https://airoutepilot.vercel.app"}/sitemap.xml` };
}
