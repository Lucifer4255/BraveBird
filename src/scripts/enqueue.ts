import { inngest } from "../orchestration/inngest.js";
import { SAMPLE_JOBS } from "../orchestration/sampleJobs.js";
import type { BookingParams } from "../workflows/booking.js";

/**
 * Send the 5 "find the best hotel" jobs as Inngest events. The worker
 * (`npm run worker`) + the Inngest dev server run them with per-site pacing and
 * retries — watch the timeline at http://localhost:8288.
 *
 *   npm run enqueue
 */
async function main() {
  for (const job of SAMPLE_JOBS) {
    await inngest.send({ name: "automation/job.requested", data: job });
    const p = job.params as unknown as BookingParams;
    console.log(`enqueued ${job.id.padEnd(8)} → ${p.destination} · ${p.adults} adults · 3 nights · ≤ ₹${p.maxTotalPrice.toLocaleString("en-IN")} · rating ≥ ${p.minRating}`);
  }
  console.log(`\n${SAMPLE_JOBS.length} jobs sent → watch them run at http://localhost:8288`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
