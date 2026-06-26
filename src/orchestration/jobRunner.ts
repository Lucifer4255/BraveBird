import type { BrowserManager } from "../core/browserManager.js";
import { captureFailure } from "../core/telemetry.js";
import { BotWallError, type Job } from "../workflows/base.js";
import { getWorkflow } from "./registry.js";

/**
 * Run one job once. This is the seam everything composes through:
 *   acquire identity+proxy → run workflow → record outcome → persist → release.
 *
 * Detect-and-react: a BotWallError burns the identity AND its proxy
 * (`recordBlock`), so whoever retries — Inngest, or the local loop below — gets
 * a FRESH persona + IP. The browser context is always released in `finally`.
 */
export async function runJob(bm: BrowserManager, job: Job): Promise<unknown> {
  const workflow = getWorkflow(job.site);
  const context = await bm.acquireContext({ sessionKey: job.id });

  try {
    const result = await workflow.run(context, job);
    bm.recordSuccess(context);
    await bm.persistSession(context);
    return result;
  } catch (err) {
    if (err instanceof BotWallError) bm.recordBlock(context); // burn identity + proxy
    // Forensics while the context is still open (page is live); finally still closes it.
    await captureFailure(context, {
      jobId: job.id,
      site: job.site,
      error: err,
      identity: bm.identityFor(context)?.id,
      proxy: bm.proxyFor(context),
    }).catch(() => {});
    throw err;
  } finally {
    await bm.releaseContext(context);
  }
}

/**
 * Local "detect-and-react" loop for zero-infra runs (the Inngest path uses its
 * own native retries instead). A bot wall rotates to a fresh identity+proxy;
 * any other error fails fast.
 */
export async function runJobWithRetries(
  bm: BrowserManager,
  job: Job,
  maxAttempts = 3,
): Promise<unknown> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await runJob(bm, job);
    } catch (err) {
      lastError = err;
      if (!(err instanceof BotWallError)) throw err; // not a wall → don't rotate
      // identity+proxy already burned in runJob → next attempt is fresh
    }
  }
  throw lastError;
}
