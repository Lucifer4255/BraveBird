import { config } from "./config.js";
import { BrowserManager } from "./core/browserManager.js";
import { runJobWithRetries } from "./orchestration/jobRunner.js";
import { SAMPLE_JOBS } from "./orchestration/sampleJobs.js";
import type { Job } from "./workflows/base.js";
import type { BookingParams, BookingResult } from "./workflows/booking.js";

/**
 * Zero-infra direct runner — runs the 5 "find the best hotel" jobs in-process
 * with a bounded-concurrency pool (no Inngest dev server needed). For the scale
 * demo, use Inngest instead: `npm run worker` + dev server + `npm run enqueue`.
 *
 *   npm run dev
 *   WORKER_CONCURRENCY=3 npm run dev
 */
const JOBS = SAMPLE_JOBS;

function summarize(r: BookingResult): string {
  return r.best
    ? `${r.best.name} — ${r.best.rating}/10 · ${r.best.priceText} (${r.qualified}/${r.scanned} matched)`
    : `no hotel ≥${r.minRating} under ₹${r.budget.toLocaleString("en-IN")} (${r.scanned} scanned)`;
}

/** Bounded-concurrency in-process worker pool. */
async function processAll(bm: BrowserManager, jobs: Job[], limit: number) {
  const queue = [...jobs];
  const results = new Map<string, string>();
  const worker = async () => {
    for (let job = queue.shift(); job; job = queue.shift()) {
      const dest = (job.params as unknown as BookingParams).destination;
      console.log(`▶ [${dest}] searching…`);
      try {
        results.set(dest, summarize((await runJobWithRetries(bm, job)) as BookingResult));
        console.log(`✅ [${dest}] ${results.get(dest)}`);
      } catch (err) {
        results.set(dest, `failed: ${(err as Error).message}`);
        console.log(`❌ [${dest}] ${(err as Error).message}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, jobs.length) }, worker));
  return results;
}

async function main() {
  console.log(`Bravebird worker · ${JOBS.length} jobs · concurrency ${config.worker.concurrency}\n`);
  const bm = new BrowserManager();
  await bm.start();
  try {
    const results = await processAll(bm, JOBS, config.worker.concurrency);
    console.log("\n── best hotel per destination ──");
    for (const [dest, line] of results) console.log(`  ${dest.padEnd(9)} → ${line}`);
    console.log(`\nhealthy identities remaining: ${bm.healthyIdentityCount}`);
  } finally {
    await bm.stop();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
