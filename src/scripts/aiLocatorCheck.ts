import { chromium } from "playwright";
import { config } from "../config.js";
import { __healCache, resolveWithMeta, type LocatorSpec } from "../core/locators.js";

/**
 * Live verification of the Tier-4 OpenRouter AI resolver.
 *
 *   AI_LOCATOR_ENABLED=true OPENROUTER_API_KEY=sk-... npx tsx src/scripts/aiLocatorCheck.ts
 *
 * The spec gives ONLY a natural-language description + a deliberately-wrong CSS,
 * so every deterministic tier misses and Tier-4 must call the LLM. We then
 * resolve a second time to prove the result was cached (heal once → deterministic).
 */
const PAGE = `<!doctype html><html><body>
  <main>
    <h1>Your cart</h1>
    <button class="qa-7f">Continue shopping</button>
    <button class="qa-2c">Remove item</button>
    <button class="qa-9z">Proceed to checkout</button>
  </main>
</body></html>`;

async function main() {
  if (!config.ai.enabled) {
    console.error("Set AI_LOCATOR_ENABLED=true to run this.");
    process.exit(1);
  }
  if (!config.ai.apiKey) {
    console.error("Set OPENROUTER_API_KEY in .env to run the live AI test.");
    process.exit(1);
  }
  console.log(`model: ${config.ai.model}`);

  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  const page = await browser.newPage();
  await page.setContent(PAGE);

  // Only a description + a wrong css → forces deterministic miss → Tier-4 AI.
  const spec: LocatorSpec = {
    id: "checkout-button",
    css: ".does-not-exist-zzz",
    description: "the button that proceeds to checkout / payment",
  };

  console.log("\n── first resolve (deterministic miss → AI) ──");
  const r1 = await resolveWithMeta(page, spec);
  console.log(`tier      : ${r1.tier.toUpperCase()}`);
  console.log(`AI selector: ${__healCache.get(spec.id)}`);
  console.log(`element    : "${(await r1.locator.textContent())?.trim()}"`);

  console.log("\n── second resolve (should hit cache, no LLM call) ──");
  const r2 = await resolveWithMeta(page, spec);
  console.log(`tier      : ${r2.tier.toUpperCase()}`);

  const ok =
    r1.tier === "ai" &&
    r2.tier === "cache" &&
    /checkout/i.test((await r1.locator.textContent()) ?? "");
  console.log("\nRESULT:", ok ? "✅ AI resolved + cached (heal once, then deterministic)" : "❌ unexpected");

  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
