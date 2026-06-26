import { chromium } from "playwright";
import { STEALTH_LAUNCH_ARGS } from "../core/stealth.js";
import { FingerprintFactory } from "../evasion/fingerprint.js";

/**
 * Headed "watch it live" demo for learning — NOT part of the worker.
 *
 *   npx tsx src/scripts/liveDemo.ts
 *
 * Launches a VISIBLE Chrome (headless: false) with slowMo so each action is
 * watchable, reuses our real stealth layer, visits the bot detector, then types
 * into a live login form so you can see automation behave like a human.
 */
async function main() {
  const browser = await chromium.launch({
    headless: false, // ← the whole point: a real window appears
    slowMo: 300, // ms pause between actions so the eye can follow
    args: STEALTH_LAUNCH_ARGS,
  });
  const fingerprint = new FingerprintFactory().create();
  const context = await fingerprint.createContext(browser); // coherent fingerprint + stealth
  const page = await context.newPage();

  console.log("→ 1/3  opening the bot detector — watch the window…");
  await page.goto("https://bot.sannysoft.com/", {
    waitUntil: "networkidle",
    timeout: 60_000,
  });
  await page.waitForTimeout(4000);

  console.log("→ 2/3  navigating to a real login form…");
  await page.goto("https://www.saucedemo.com/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);

  console.log("→ 3/3  typing credentials like a human (slowMo)…");
  await page.getByPlaceholder("Username").fill("standard_user");
  await page.getByPlaceholder("Password").fill("secret_sauce");
  await page.waitForTimeout(2500);

  console.log("→ closing window in 3s…");
  await page.waitForTimeout(3000);
  await context.close();
  await browser.close();
  console.log("done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
