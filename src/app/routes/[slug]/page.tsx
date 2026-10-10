import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { POPULAR_ROUTES, findRoute, slugOf } from "@/lib/seo/routes";
import { resolvePlaceStrict } from "@/lib/geo/directory";

type Props = { params: Promise<{ slug: string }> };
export const dynamicParams = false;
export const generateStaticParams = () => POPULAR_ROUTES.map(([a, b]) => ({ slug: slugOf(a, b) }));

function km(a: { lat: number; lon: number }, b: { lat: number; lon: number }) {
  const r = Math.PI / 180, dLat = (b.lat - a.lat) * r, dLon = (b.lon - a.lon) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
  return Math.round(12742 * Math.asin(Math.sqrt(h)));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const r = findRoute((await params).slug);
  if (!r) return {};
  return { title: `${r[0]} to ${r[1]}: plan by train, flight and bus`, description: `Compare ways to travel from ${r[0]} to ${r[1]} by train, flight and bus, ranked by speed and cost. Fares are estimates.`, alternates: { canonical: `/routes/${slugOf(r[0], r[1])}` } };
}

export default async function RoutePage({ params }: Props) {
  const r = findRoute((await params).slug);
  if (!r) notFound();
  const [from, to] = r;
  const a = resolvePlaceStrict(from), b = resolvePlaceStrict(to);
  const d = a && b ? km(a, b) : null;
  const hint = d == null ? null : d < 300 ? "short enough that road or rail is usually the simplest choice" : d < 900 ? "a range where trains, buses and flights are all worth comparing" : "far enough that flying, or a mix of rail and flight, often saves the most time";
  const qs = `?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
  return (
    <article>
      <h1>{from} to {to}</h1>
      {d != null && <p>The straight-line distance is about <strong>{d.toLocaleString("en-IN")} km</strong>, {hint}. Actual road and rail distances are longer.</p>}
      <p>RoutePilot AI builds door-to-door options for this journey across trains, flights and buses, with realistic connection buffers, then ranks them fastest, cheapest or best value.</p>
      <p><Link href={`/${qs}`} className="btn">Plan {from} to {to}</Link></p>
      <p className="muted">Fares and timetables in RoutePilot are currently estimates, not live prices. Each leg links to the operator&apos;s own site to confirm the real fare before you book.</p>
      <h2>More journeys</h2>
      <ul>{POPULAR_ROUTES.filter(([x, y]) => x !== from || y !== to).slice(0, 12).map(([x, y]) => <li key={slugOf(x, y)}><Link href={`/routes/${slugOf(x, y)}`}>{x} to {y}</Link></li>)}</ul>
    </article>
  );
}
