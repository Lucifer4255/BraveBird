import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";
import { STEALTH_LAUNCH_ARGS } from "../core/stealth.js";
import { FingerprintFactory } from "../evasion/fingerprint.js";

/**
 * Recon for M3 — load the REAL Booking.com and report what's actually on the
 * page, so we write booking.ts against reality instead of guessing selectors.
 *
 *   npx tsx src/scripts/reconBooking.ts            (headless)
 *   HEADLESS=false npx tsx src/scripts/reconBooking.ts   (watch it)
 */
async function main() {
  await mkdir("telemetry", { recursive: true });
  const headed = process.env.HEADLESS === "false";

  const browser = await chromium.launch({
    headless: !headed,
    slowMo: headed ? 200 : 0,
    args: STEALTH_LAUNCH_ARGS,
  });
  const context = await new FingerprintFactory().create().createContext(browser);
  const page = await context.newPage();

  console.log("→ navigating to booking.com …");
  const resp = await page.goto("https://www.booking.com/", {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  await page.waitForTimeout(3500); // let dynamic content settle

  console.log("\n── page identity ──");
  console.log("HTTP status :", resp?.status());
  console.log("final URL   :", page.url());
  console.log("title       :", await page.title());

  const bodyText = (await page.locator("body").innerText().catch(() => "")).slice(0, 300);
  const blocked = /are you a robot|verify you are human|captcha|access denied|unusual traffic/i.test(
    bodyText,
  );
  console.log("bot-wall?   :", blocked ? "⚠️  POSSIBLE BLOCK" : "looks ok");

  console.log("\n── candidate selectors (✓ = present) ──");
  const candidates: Array<[string, string]> = [
    ["consent  #onetrust-accept-btn-handler", "#onetrust-accept-btn-handler"],
    ["consent  button[aria-label*=Accept]", "button[aria-label*='Accept']"],
    ["dest     input[name=ss]", "input[name='ss']"],
    ["dest     [data-testid=destination-container] input", "[data-testid='destination-container'] input"],
    ["dates    [data-testid=date-display-field-start]", "[data-testid='date-display-field-start']"],
    ["occupancy [data-testid=occupancy-config]", "[data-testid='occupancy-config']"],
    ["submit   button[type=submit]", "button[type='submit']"],
  ];
  for (const [label, sel] of candidates) {
    const n = await page.locator(sel).count().catch(() => 0);
    console.log(`  ${n > 0 ? "✓" : "·"}  ${label}  → ${n}`);
  }

  console.log("\n── role/semantic probes ──");
  console.log("  combobox             :", await page.getByRole("combobox").count().catch(() => 0));
  console.log("  placeholder 'where…' :", await page.getByPlaceholder(/where are you going/i).count().catch(() => 0));
  console.log("  button name 'Search' :", await page.getByRole("button", { name: /search/i }).count().catch(() => 0));

  await page.screenshot({ path: "telemetry/booking-recon.png" });
  console.log("\nscreenshot  : telemetry/booking-recon.png");

  await context.close();
  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
