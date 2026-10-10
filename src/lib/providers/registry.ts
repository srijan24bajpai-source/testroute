import type { SegmentProvider } from "./types";
import { DemoProvider } from "./demo";

/**
 * Provider registry. Live adapters (e.g. a licensed flight distribution/NDC partner) must be added here only
 * once the owner holds credentials/agreements. See API_INTEGRATIONS.md.
 * Feature flag: DISABLED_PROVIDERS=id1,id2 turns an integration off without a code change.
 */
export function getSegmentProviders(env: NodeJS.ProcessEnv = process.env): SegmentProvider[] {
  const disabled = new Set((env.DISABLED_PROVIDERS ?? "").split(",").map((s) => s.trim()).filter(Boolean));
  const all: SegmentProvider[] = [
    new DemoProvider("demo-flights", "Demo flights", "flight"),
    new DemoProvider("demo-trains", "Demo trains", "train"),
    new DemoProvider("demo-buses", "Demo buses", "bus"),
  ];
  return all.filter((p) => p.isConfigured() && !disabled.has(p.id));
}
