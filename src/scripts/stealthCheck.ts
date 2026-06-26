import { mkdir } from "node:fs/promises";
import { BrowserManager } from "../core/browserManager.js";

/**
 * Manual verification for the M1 stealth layer.
 *
 *   npm run stealth:check
 *
 * Opens a public bot-detection page, screenshots it, and reads back the exact
 * values a detector would inspect. If stealth works, webdriver is `undefined`,
 * the UA is a normal Chrome (not "HeadlessChrome"), and plugins are non-empty.
 */
async function main() {
  await mkdir("telemetry", { recursive: true });

  const bm = new BrowserManager();
  await bm.start();
  const context = await bm.acquireContext();

  try {
    const page = await context.newPage();

    // A well-known fingerprint test page that visually flags each signal.
    await page.goto("https://bot.sannysoft.com/", {
      waitUntil: "networkidle",
      timeout: 60_000,
    });
    await page.screenshot({ path: "telemetry/stealth-check.png", fullPage: true });

    // Read the actual values from inside the browser (post-patch).
    const probe = await page.evaluate(() => ({
      webdriver: navigator.webdriver,
      userAgent: navigator.userAgent,
      pluginCount: navigator.plugins.length,
      languages: navigator.languages,
    }));

    console.log("\n── Stealth probe ─────────────────────────────");
    console.log("navigator.webdriver :", probe.webdriver, "(want: NOT true)");
    console.log("userAgent           :", probe.userAgent);
    console.log("plugins.length      :", probe.pluginCount, "(want: > 0)");
    console.log("languages           :", probe.languages.join(", "), "(want: 2)");
    console.log("open contexts       :", bm.openContextCount, "(want: 1 here)");
    console.log("screenshot          : telemetry/stealth-check.png");

    // Only `webdriver === true` is the giveaway; real Chrome reports false/undefined.
    // Universal bot tells. (plugins/languages are now set by the fingerprint
    // injector from real data — realistic values, not our old fixed ones — so
    // they're informational here, not pass/fail.)
    const pass = probe.webdriver !== true && !/headless/i.test(probe.userAgent);
    console.log("\nRESULT:", pass ? "✅ PASS" : "❌ FAIL");
  } finally {
    // The whole point of M1: clean teardown, even on error.
    await bm.releaseContext(context);
    await bm.stop();
    console.log("after teardown      :", bm.openContextCount, "open contexts (want: 0)\n");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
