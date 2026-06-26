import { Inngest, type InngestFunction } from "inngest";
import { config } from "../config.js";
import { BrowserManager } from "../core/browserManager.js";
import type { Job } from "../workflows/base.js";
import { runJob } from "./jobRunner.js";

/**
 * Inngest-native orchestration — the scale layer.
 *
 * The lower layers (browser/stealth/identity/proxy/workflow) are unchanged; this
 * just paces and retries them. Inngest gives us, for free, the two things "1k
 * workers ingesting jobs" needs:
 *   - FLOW CONTROL — `concurrency` + `throttle` keyed PER SITE, so no single
 *     target ever gets a burst of traffic (the pacing we keep talking about).
 *   - RETRIES — and because runJob burns the identity+proxy on a bot wall, each
 *     retry automatically rotates to a fresh persona + IP (detect-and-react).
 */
export const inngest = new Inngest({
  id: "bravebird-automation",
  // Dev mode unless a production signing key is configured.
  isDev: !process.env.INNGEST_SIGNING_KEY,
});

// One Chromium per worker process, shared across all function runs.
// Cache the PROMISE (not the instance): with concurrency > 1, two invocations
// can call this at once — caching the instance would hand the second caller a
// not-yet-started manager (race). Awaiting one shared promise fixes that.
let managerPromise: Promise<BrowserManager> | undefined;
function browser(): Promise<BrowserManager> {
  if (!managerPromise) {
    managerPromise = (async () => {
      const m = new BrowserManager();
      await m.start();
      return m;
    })();
  }
  return managerPromise;
}

export const runAutomationJob: InngestFunction.Any = inngest.createFunction(
  {
    id: "run-automation-job",
    triggers: [{ event: "automation/job.requested" }],
    // Pace per target site: cap concurrent runs and evenly throttle starts.
    concurrency: { limit: config.worker.concurrency, key: "event.data.site" },
    throttle: { limit: config.worker.concurrency, period: "10s", key: "event.data.site" },
    // Each retry rotates identity+proxy (runJob burned the bad one).
    retries: 3,
  },
  async ({ event }) => {
    const job = event.data as Job;
    return runJob(await browser(), job);
  },
);

export const functions: InngestFunction.Any[] = [runAutomationJob];
