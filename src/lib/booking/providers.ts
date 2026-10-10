import type { BookingProvider } from "../providers/types";

/**
 * Live booking adapters register here once the owner has a signed provider agreement and credentials.
 * None ship today: demo/search-only providers can never issue tickets, so in-app booking returns
 * BOOKING_NOT_AVAILABLE and the UI offers the provider's official channel instead.
 */
/** True only when at least one real booking adapter is registered (none ship today). */
export function liveBookingAvailable(): boolean {
  return false;
}

export function getBookingProvider(providerId: string): BookingProvider | undefined {
  void providerId;
  return undefined;
}
