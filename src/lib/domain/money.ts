import type { Money } from "./types";

export const inr = (rupees: number): Money => ({ amount: Math.round(rupees * 100), currency: "INR" });

/** Format minor units as ₹ with Indian digit grouping. */
export function formatInr(paise: number): string {
  const rupees = Math.round(paise / 100);
  return "₹" + rupees.toLocaleString("en-IN");
}
