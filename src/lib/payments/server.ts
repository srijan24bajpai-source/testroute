import { getBookingProvider } from "../booking/providers";
import { getStore } from "../booking/store";
import { BookingError } from "../booking/service";
import { getGateway } from "./registry";
import type { PayDeps } from "./service";

/** Builds the dependencies for payment routes. Return URLs come from APP_ORIGIN, never from the request body. */
export function payDeps(req: Request): PayDeps {
  const configured = process.env.APP_ORIGIN;
  if (!configured && process.env.NODE_ENV === "production") {
    throw new BookingError("MISCONFIGURED", "The site address (APP_ORIGIN) is not configured, so payments are disabled.", 503);
  }
  return { store: getStore(), getBookingProvider, gateway: (id) => getGateway(id), origin: configured ?? new URL(req.url).origin };
}
