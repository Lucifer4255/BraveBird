import { rmSync } from "node:fs";
import { chromium } from "playwright";
import { IdentityPool } from "../evasion/identity.js";

/**
 * Verify M4 — durable identities: rotation, stickiness, health-based retire,
 * persistence, and fingerprint coherence.
 *   npx tsx src/scripts/identityCheck.ts
 */
const DIR = "telemetry/identity-demo";

async function main() {
  rmSync(DIR, { recursive: true, force: true }); // clean slate for the demo
  const pool = new IdentityPool({ dir: DIR, size: 4, maxBlocks: 2 });
  console.log("fingerprint mode:", pool.mode, "| pool size:", pool.all.length);

  console.log("\n── rotation (round-robin over personas) ──");
  for (let i = 0; i < 5; i++) {
    const id = pool.acquire();
    console.log(`  ${id.id}  ${id.fingerprint.summary}`);
  }

  console.log("\n── stickiness (same key → same persona) ──");
  const a = pool.acquire("session-A").id;
  const a2 = pool.acquire("session-A").id;
  console.log(`  session-A: ${a} then ${a2}  (stable: ${a === a2})`);

  console.log("\n── health: 2 blocks retires a persona ──");
  pool.recordBlock(a);
  pool.recordBlock(a);
  const a3 = pool.acquire("session-A").id;
  console.log(`  blocked ${a} twice → session-A reassigned to ${a3} (changed: ${a3 !== a})`);
  console.log(`  healthy identities: ${pool.healthyCount} of ${pool.all.length}`);

  console.log("\n── persistence (durable across runs) ──");
  const pool2 = new IdentityPool({ dir: DIR, size: 4 });
  const sameIds = pool2.all.map((i) => i.id).sort().join(",") === pool.all.map((i) => i.id).sort().join(",");
  const retiredPersisted = pool2.all.find((i) => i.id === a)?.health.retired === true;
  console.log(`  reloaded same personas: ${sameIds ? "✅" : "❌"} | retirement persisted: ${retiredPersisted ? "✅" : "❌"}`);

  console.log("\n── coherence (browser matches the persona's fingerprint) ──");
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-blink-features=AutomationControlled"],
  });
  const identity = pool2.all.find((i) => !i.health.retired)!;
  const ctx = await identity.fingerprint.createContext(browser);
  const page = await ctx.newPage();
  await page.goto("about:blank");
  const probe = await page.evaluate(() => ({ platform: navigator.platform, webdriver: navigator.webdriver }));
  console.log(`  persona ${identity.id} (${identity.fingerprint.summary})`);
  console.log(`  browser platform=${probe.platform} matches=${probe.platform === identity.fingerprint.platform ? "✅" : "❌"}  webdriver hidden=${probe.webdriver === false ? "✅" : "❌"}`);

  await browser.close();
  rmSync(DIR, { recursive: true, force: true });
  console.log("\n✅ durable identity pool verified.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
