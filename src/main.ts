import { config } from "./config.js";
import { BrowserManager } from "./core/browserManager.js";
import { runJobWithRetries } from "./orchestration/jobRunner.js";
import { registeredSites } from "./orchestration/registry.js";
import type { Job } from "./workflows/base.js";

/**
 * Zero-infra direct worker — runs jobs in-process with a bounded-concurrency
 * pool and the local detect-and-react retry loop. No Inngest dev server needed.
 * (For scale, run `npm run worker` + the Inngest dev server instead.)
 *
 *   npm run dev
 */
const JOBS: Job[] = [
  { id: "j1", site: "booking", params: { destination: "Goa", checkin: "2026-06-26", checkout: "2026-06-28", adults: 2 } },
  { id: "j2", site: "booking", params: { destination: "Lisbon", checkin: "2026-07-10", checkout: "2026-07-12", adults: 2 } },
];

function summarize(result: unknown): string {
  const r = result as { propertyCount?: number };
  return r?.propertyCount !== undefined ? `${r.propertyCount} results` : "ok";
}

/** Bounded-concurrency in-process worker pool. */
async function processAll(bm: BrowserManager, jobs: Job[], limit: number) {
  const queue = [...jobs];
  const results: Array<{ id: string; ok: boolean; info: string }> = [];
  const worker = async () => {
    for (let job = queue.shift(); job; job = queue.shift()) {
      try {
        results.push({ id: job.id, ok: true, info: summarize(await runJobWithRetries(bm, job)) });
      } catch (err) {
        results.push({ id: job.id, ok: false, info: (err as Error).message });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, jobs.length) }, worker));
  return results;
}

async function main() {
  console.log(`direct worker | sites: [${registeredSites().join(", ")}] | concurrency: ${config.worker.concurrency}`);
  const bm = new BrowserManager();
  await bm.start();
  try {
    const results = await processAll(bm, JOBS, config.worker.concurrency);
    for (const r of results) console.log(`  ${r.ok ? "✅" : "❌"} ${r.id}: ${r.info}`);
    console.log(`healthy identities remaining: ${bm.healthyIdentityCount}`);
  } finally {
    await bm.stop();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
