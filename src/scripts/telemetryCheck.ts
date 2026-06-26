import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "playwright";
import { BrowserManager } from "../core/browserManager.js";
import { IdentityPool } from "../evasion/identity.js";
import { runJob } from "../orchestration/jobRunner.js";
import { registerWorkflow } from "../orchestration/registry.js";
import { type Job, Workflow } from "../workflows/base.js";

/** Verify M8 — a hard failure captures error.log + screenshot + html + trace. */
const POOL_DIR = "telemetry/tele-demo";

/** Lands on a real page, then fails in extract (so the page has content to snapshot). */
class AlwaysFailWorkflow extends Workflow {
  readonly site = "fail-test";
  protected async open(page: Page, _job: Job): Promise<void> {
    await page.goto("data:text/html,<h1>telemetry%20test%20page</h1>");
  }
  protected async isLoggedIn(_page: Page): Promise<boolean> {
    return true;
  }
  protected async login(_page: Page, _job: Job): Promise<void> {}
  protected async navigate(_page: Page, _job: Job): Promise<void> {}
  protected async extract(_page: Page, _job: Job): Promise<unknown> {
    throw new Error("boom — simulated hard failure in extract");
  }
}

async function main() {
  registerWorkflow("fail-test", () => new AlwaysFailWorkflow());
  const bm = new BrowserManager(new IdentityPool({ dir: POOL_DIR, size: 1 }));
  await bm.start();

  const job: Job = { id: "tele-1", site: "fail-test", params: {} };
  try {
    await runJob(bm, job);
  } catch {
    /* expected — the workflow always fails */
  } finally {
    await bm.stop();
  }

  // Find the failure dir and check the artifacts.
  const base = join("telemetry", "failures");
  const dirs = (await readdir(base).catch(() => [])).filter((d) => d.startsWith("tele-1"));
  const dir = dirs.sort().at(-1);
  console.log("── failure artifacts ──");
  if (!dir) {
    console.log("❌ no failure dir written");
    process.exit(1);
  }
  const files = await readdir(join(base, dir));
  const want = ["error.log", "screenshot.png", "page.html", "trace.zip"];
  let pass = true;
  for (const f of want) {
    const ok = files.includes(f);
    pass &&= ok;
    console.log(`  ${ok ? "✅" : "❌"} ${f}`);
  }
  console.log(`  dir: telemetry/failures/${dir}`);

  // cleanup demo artifacts
  await rm(POOL_DIR, { recursive: true, force: true });
  await rm(join(base, dir), { recursive: true, force: true });

  console.log(`\nRESULT: ${pass ? "✅ forensics captured on hard failure" : "❌ missing artifacts"}`);
  if (!pass) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
