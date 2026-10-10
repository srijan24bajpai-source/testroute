import { PayPalGateway } from "./paypal";
import { PhonePeGateway } from "./phonepe";
import type { GatewayId, PaymentGateway } from "./types";

/** Payments stay OFF unless PAYMENTS_ENABLED=true AND the gateway's credentials are present. */
export function paymentsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PAYMENTS_ENABLED === "true";
}

export const ALL_GATEWAYS: GatewayId[] = ["phonepe", "paypal"];

/**
 * PAYMENT_GATEWAYS=phonepe,paypal chooses WHICH gateways may be used and in WHAT ORDER they are offered.
 * Unset = all known gateways, PhonePe first. A gateway also needs its own credentials to be active.
 */
export function allowedGateways(env: NodeJS.ProcessEnv = process.env): GatewayId[] {
  const listed = (env.PAYMENT_GATEWAYS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter((g): g is GatewayId => (ALL_GATEWAYS as string[]).includes(g));
  return listed.length ? [...new Set(listed)] : ALL_GATEWAYS;
}

export function getGateway(id: GatewayId, env: NodeJS.ProcessEnv = process.env): PaymentGateway | undefined {
  if (!paymentsEnabled(env) || !allowedGateways(env).includes(id)) return undefined;
  return (id === "phonepe" ? PhonePeGateway.fromEnv(env) : PayPalGateway.fromEnv(env)) ?? undefined;
}

export function configuredGateways(env: NodeJS.ProcessEnv = process.env): GatewayId[] {
  return allowedGateways(env).filter((g) => getGateway(g, env));
}
