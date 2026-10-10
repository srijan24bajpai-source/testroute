import { json } from "@/lib/security/http";
import { liveBookingAvailable } from "@/lib/booking/providers";
import { getLiveFlights } from "@/lib/providers/duffel";
import { supabaseConfigured } from "@/lib/supabase/server";
import { getSegmentProviders } from "@/lib/providers/registry";
import { llmEnabled } from "@/lib/agent/llm";
import { configuredGateways, paymentsEnabled } from "@/lib/payments/registry";

export const dynamic = "force-dynamic";

export function GET() {
  return json({
    ok: true,
    features: {
      auth: supabaseConfigured(),
      llm: llmEnabled(),
      botChallenge: Boolean(process.env.TURNSTILE_SECRET_KEY),
      distributedRateLimit: Boolean(process.env.UPSTASH_REDIS_REST_URL),
      providers: getSegmentProviders().map((p) => ({ id: p.id, capability: p.capability })),
      liveFares: { flights: getLiveFlights() ? "duffel" : null },
      liveBooking: liveBookingAvailable(),
      payments: { enabled: paymentsEnabled(), gateways: configuredGateways() },
    },
  });
}
