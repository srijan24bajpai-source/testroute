import type { Metadata, Viewport } from "next";
import Link from "next/link";
import { brand } from "@/config/brand";
import { ThemeToggle } from "@/components/ThemeToggle";
import "./globals.css";

const description = `${brand.tagline} Compare door-to-door options across India and the world. Fares shown are estimates until a live provider is connected.`;

export const metadata: Metadata = {
  metadataBase: new URL(process.env.APP_ORIGIN || "https://airoutepilot.vercel.app"),
  title: { default: `${brand.name} · AI travel planner`, template: `%s · ${brand.name}` },
  description,
  openGraph: { type: "website", siteName: brand.name, title: `${brand.name} · AI travel planner`, description },
  twitter: { card: "summary", title: `${brand.name} · AI travel planner`, description },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#f4f6fb",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-theme="light" suppressHydrationWarning>
      <head>
        {/* Apply the saved theme before paint to avoid a flash. Light by default. */}
        <script dangerouslySetInnerHTML={{ __html: `try{var t=localStorage.getItem("rp-theme");if(t==="dark"||t==="light")document.documentElement.dataset.theme=t}catch(e){}` }} />
      </head>
      <body>
        <a href="#main" className="skip">Skip to content</a>
        <header className="top">
          <Link href="/" className="logo">✈ {brand.name}</Link>
          <nav aria-label="Main">
            <Link href="/dashboard">My trips</Link>
            <Link href="/login">Sign in</Link>
            <ThemeToggle />
          </nav>
        </header>
        <main id="main">{children}</main>
        <footer className="foot">
          <Link href="/privacy">Privacy</Link> · <Link href="/terms">Terms</Link> · <Link href="/account">Account &amp; data</Link>
          <div className="muted" style={{ marginTop: 6 }}>Place data: <a href="https://www.geonames.org" target="_blank" rel="noopener noreferrer">GeoNames</a> (CC BY 4.0) and <a href="https://ourairports.com" target="_blank" rel="noopener noreferrer">OurAirports</a> (public domain).</div>
        </footer>
      </body>
    </html>
  );
}
