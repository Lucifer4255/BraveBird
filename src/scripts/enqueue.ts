import { inngest } from "../orchestration/inngest.js";
import type { Job } from "../workflows/base.js";

/**
 * Send sample jobs as Inngest events (needs the dev server + worker running).
 *   npm run enqueue
 */
const stamp = Date.now();
const JOBS: Job[] = [
  { id: `booking-${stamp}-1`, site: "booking", params: { destination: "Goa", checkin: "2026-06-26", checkout: "2026-06-28", adults: 2 } },
  { id: `booking-${stamp}-2`, site: "booking", params: { destination: "Lisbon", checkin: "2026-07-10", checkout: "2026-07-12", adults: 2 } },
];

async function main() {
  for (const job of JOBS) {
    await inngest.send({ name: "automation/job.requested", data: job });
    console.log(`enqueued ${job.id} → ${(job.params as { destination: string }).destination}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
