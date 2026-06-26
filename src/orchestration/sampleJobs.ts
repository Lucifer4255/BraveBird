import type { Job } from "../workflows/base.js";
import type { BookingParams } from "../workflows/booking.js";

/**
 * The demo job set: 5 "find the best hotel" jobs — different cities, budgets, and
 * rating floors, all 3-night stays. Shared by the Inngest enqueue path and the
 * zero-infra direct runner so they never drift. Fetches prices only (no booking).
 */
const make = (id: string, params: BookingParams): Job => ({
  id,
  site: "booking",
  params: params as unknown as Record<string, unknown>,
});

export const SAMPLE_JOBS: Job[] = [
  make("goa", { destination: "Goa", checkin: "2026-06-26", checkout: "2026-06-29", adults: 3, maxTotalPrice: 15_000, minRating: 8.0, currency: "INR" }),
  make("mumbai", { destination: "Mumbai", checkin: "2026-07-10", checkout: "2026-07-13", adults: 2, maxTotalPrice: 18_000, minRating: 8.0, currency: "INR" }),
  make("jaipur", { destination: "Jaipur", checkin: "2026-07-10", checkout: "2026-07-13", adults: 2, maxTotalPrice: 9_000, minRating: 8.5, currency: "INR" }),
  make("manali", { destination: "Manali", checkin: "2026-07-10", checkout: "2026-07-13", adults: 4, maxTotalPrice: 20_000, minRating: 8.0, currency: "INR" }),
  make("udaipur", { destination: "Udaipur", checkin: "2026-07-10", checkout: "2026-07-13", adults: 2, maxTotalPrice: 12_000, minRating: 9.0, currency: "INR" }),
];
