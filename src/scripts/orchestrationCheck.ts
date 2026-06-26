import { rmSync } from "node:fs";
import type { Page } from "playwright";
import { BrowserManager } from "../core/browserManager.js";
import { IdentityPool } from "../evasion/identity.js";
import { functions } from "../orchestration/inngest.js";
import { runJobWithRetries } from "../orchestration/jobRunner.js";
import { registerWorkflow } from "../orchestration/registry.js";
import { BotWallError, type Job, Workflow } from "../workflows/base.js";

/**
 * Verify M7 — detect-and-react retry, deterministically (no network):
 * a workflow that hits a bot wall on the first try should burn that identity and
 * succeed on a fresh one. Also confirms the Inngest function is defined.
 */
const DIR = "telemetry/orch-demo";
let attempts = 0;

/** Bot wall on attempt 1, success on the next (which uses a fresh persona). */
class FlakyWorkflow extends Workflow {
  readonly site = "flaky-test";
  protected async open(_page: Page, _job: Job): Promise<void> {}
  protected async isLoggedIn(_page: Page): Promise<boolean> {
    return true;
  }
  protected async login(_page: Page, _job: Job): Promise<void> {}
  protected async navigate(_page: Page, _job: Job): Promise<void> {}
  protected async extract(_page: Page, _job: Job): Promise<unknown> {
    attempts++;
    if (attempts === 1) throw new BotWallError("simulated bot wall (attempt 1)");
    return { ok: true, attempt: attempts };
  }
}

async function main() {
  rmSync(DIR, { recursive: true, force: true });
  registerWorkflow("flaky-test", () => new FlakyWorkflow());

  // maxBlocks:1 → one block retires the identity, forcing a fresh one on retry.
  const pool = new IdentityPool({ dir: DIR, size: 3, maxBlocks: 1 });
  const bm = new BrowserManager(pool);
  await bm.start();

  try {
    console.log("── detect-and-react retry ──");
    console.log(`healthy before: ${pool.healthyCount}/${pool.all.length}`);

    const job: Job = { id: "flaky-1", site: "flaky-test", params: {} };
    const result = await runJobWithRetries(bm, job, 3);

    console.log(`result          : ${JSON.stringify(result)}`);
    console.log(`attempts taken  : ${attempts}  (1 = blocked, 2 = succeeded fresh)`);
    console.log(`healthy after   : ${pool.healthyCount}/${pool.all.length}  (1 burned identity retired)`);

    console.log("\n── inngest flow control ──");
    console.log(`functions defined: ${functions.length} (concurrency + throttle per site, retries=3)`);

    const pass =
      attempts === 2 &&
      (result as { ok?: boolean })?.ok === true &&
      pool.healthyCount === pool.all.length - 1 &&
      functions.length === 1;
    console.log(`\nRESULT: ${pass ? "✅ bot wall → identity burned → retried fresh → success" : "❌ unexpected"}`);
    if (!pass) process.exitCode = 1;
  } finally {
    await bm.stop();
    rmSync(DIR, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
