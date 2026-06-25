import { chromium } from "playwright";
import { IDENTITY_PROFILES, IdentityPool } from "../scale/identity.js";
import {
  applyStealthScripts,
  buildContextOptions,
  STEALTH_LAUNCH_ARGS,
} from "../core/stealth.js";

/**
 * Verify M4 — identity / fingerprint rotation.
 *   npx tsx src/scripts/identityCheck.ts
 */
async function main() {
  console.log("profiles:", IDENTITY_PROFILES.map((p) => p.id).join(", "));
  const pool = new IdentityPool();

  console.log("\n── rotation (round-robin) ──");
  console.log([0, 1, 2, 3].map(() => pool.acquire().id).join("  →  "));

  console.log("\n── stickiness (same key → same identity) ──");
  const a = pool.acquire("session-A").id;
  const b = pool.acquire("session-B").id;
  const a2 = pool.acquire("session-A").id;
  console.log(`session-A=${a}, session-B=${b}, session-A again=${a2}  (A stable: ${a === a2})`);

  console.log("\n── ban → reassign on next acquire ──");
  pool.ban(a);
  const a3 = pool.acquire("session-A").id;
  console.log(`banned ${a}; session-A now=${a3}  (changed: ${a3 !== a}); healthy=${pool.healthyCount}`);

  console.log("\n── coherence: real browser values match the chosen profile ──");
  const identity = IDENTITY_PROFILES[0]!;
  const browser = await chromium.launch({ headless: true, args: STEALTH_LAUNCH_ARGS });
  const context = await browser.newContext(buildContextOptions(identity));
  await applyStealthScripts(context, identity);
  const page = await context.newPage();
  await page.goto("about:blank");
  const probe = await page.evaluate(() => ({
    ua: navigator.userAgent,
    platform: navigator.platform,
    languages: navigator.languages,
    webdriver: navigator.webdriver,
  }));
  console.log("profile :", identity.id, "→ platform should be", identity.platform);
  console.log("browser :", JSON.stringify(probe));
  const coherent =
    probe.platform === identity.platform &&
    probe.ua === identity.userAgent &&
    probe.languages[0] === identity.locale;
  console.log("\nRESULT:", coherent ? "✅ UA / platform / locale all agree (coherent fingerprint)" : "❌ mismatch");
  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
