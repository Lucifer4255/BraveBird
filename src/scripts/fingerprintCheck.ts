import { chromium } from "playwright";
import { FingerprintFactory, fingerprintFromRecord } from "../evasion/fingerprint.js";

/** Verify the fingerprint source layer (M4 stage A). */
async function main() {
  const factory = new FingerprintFactory();
  console.log("factory mode:", factory.mode);

  console.log("\n── three generated fingerprints (note the variety) ──");
  const fps = [factory.create(), factory.create(), factory.create()];
  fps.forEach((fp, i) =>
    console.log(`  #${i}  ${fp.kind}  platform=${fp.platform}  tz=${fp.timezoneId}  ${fp.summary}`),
  );

  console.log("\n── inject #0 into a real browser, check coherence ──");
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-blink-features=AutomationControlled"],
  });
  const fp = fps[0]!;
  const ctx = await fp.createContext(browser);
  const page = await ctx.newPage();
  await page.goto("about:blank");
  const probe = await page.evaluate(() => ({
    platform: navigator.platform,
    ua: navigator.userAgent,
    webdriver: navigator.webdriver,
    cores: navigator.hardwareConcurrency,
  }));
  console.log("  injected:", JSON.stringify(probe));
  console.log("  platform matches profile:", probe.platform === fp.platform ? "✅" : "❌");
  console.log("  webdriver hidden       :", probe.webdriver === false ? "✅" : "❌");

  console.log("\n── persistence round-trip (durable personas) ──");
  const rebuilt = fingerprintFromRecord(fp.toJSON());
  console.log("  rebuilt platform matches:", rebuilt.platform === fp.platform ? "✅" : "❌");

  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
