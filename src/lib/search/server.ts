import type { Constraints } from "../domain/types";
import { getSegmentProviders } from "../providers/registry";
import { getLiveFlights } from "../providers/duffel";
import { planJourney } from "./plan";

export function runSearch(c: Constraints) {
  return planJourney(c, { providers: getSegmentProviders(), liveFlights: getLiveFlights() });
}
