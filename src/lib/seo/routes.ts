// Curated popular journeys for the /routes/<slug> landing pages. Names must resolve in the place directory.
export const POPULAR_ROUTES: [from: string, to: string][] = [
  ["Delhi", "Goa"], ["Mumbai", "Goa"], ["Delhi", "Manali"], ["Delhi", "Leh"], ["Jammu", "Kanyakumari"],
  ["Delhi", "Kanyakumari"], ["Mumbai", "Delhi"], ["Delhi", "Jaipur"], ["Bangalore", "Goa"], ["Chennai", "Bangalore"],
  ["Kolkata", "Darjeeling"], ["Delhi", "Varanasi"], ["Mumbai", "Pune"], ["Hyderabad", "Bangalore"], ["Delhi", "Amritsar"],
  ["Delhi", "Shimla"], ["Mumbai", "Udaipur"], ["Chennai", "Kochi"], ["Delhi", "Kolkata"], ["Lucknow", "Goa"],
  ["Delhi", "Dubai"], ["Mumbai", "London"], ["Delhi", "Bangkok"], ["Delhi", "Singapore"], ["Mumbai", "Dubai"],
];

export const slugOf = (a: string, b: string) => `${a}-to-${b}`.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
export const findRoute = (slug: string) => POPULAR_ROUTES.find(([a, b]) => slugOf(a, b) === slug);
