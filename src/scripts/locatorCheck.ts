import { chromium } from "playwright";
import { __healCache, resolveWithMeta, type LocatorSpec } from "../core/locators.js";

/**
 * Verification for the M2 self-healing locator cascade.
 *
 *   npm run locators:check
 *
 * Loads a page, then RE-loads it with the same button but renamed id+class (a
 * "redesign"). A brittle CSS selector breaks — but our cascade still finds the
 * button via its role, proving self-healing. No network or AI key needed; the
 * deterministic tiers are the whole point.
 */

// V1: button has a meaningful id + class.
const PAGE_V1 = `<!doctype html><html><body>
  <header><nav>
    <button id="searchBtn" class="btn-primary search">Search</button>
  </nav></header>
</body></html>`;

// V2: SAME button, but id + class renamed to framework-style hashes.
// Role ("button") and visible text ("Search") are unchanged.
const PAGE_V2 = `<!doctype html><html><body>
  <main><div class="toolbar">
    <button id="x9f2a" class="c-Ab12x9 q-7h2">Search</button>
  </div></main>
</body></html>`;

async function main() {
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  const page = await browser.newPage();

  // One spec, three identities. The css is intentionally brittle.
  const searchButton: LocatorSpec = {
    id: "search-button",
    role: { type: "button", name: "Search" },
    text: "Search",
    css: "#searchBtn.search", // depends on id + class — will break in V2
    description: "the Search button",
  };

  console.log("\n── V1: original markup ───────────────────────────");
  await page.setContent(PAGE_V1);
  let r = await resolveWithMeta(page, searchButton);
  console.log(`resolved via tier: ${r.tier.toUpperCase()}  (text: "${await r.locator.textContent()}")`);

  console.log("\n── V2: id + class renamed (a redesign) ───────────");
  await page.setContent(PAGE_V2);
  const brittleHits = await page.locator("#searchBtn.search").count();
  console.log(`brittle CSS '#searchBtn.search' now matches: ${brittleHits} elements  ← a naive script dies here`);
  r = await resolveWithMeta(page, searchButton);
  console.log(`our cascade resolved via tier: ${r.tier.toUpperCase()}  ← SURVIVED  (text: "${await r.locator.textContent()}")`);

  console.log("\n── css-only spec (no role/text) → Tier 3 ─────────");
  await page.setContent(`<input data-test="username" placeholder="Username">`);
  r = await resolveWithMeta(page, { id: "username", css: "[data-test=username]" });
  console.log(`resolved via tier: ${r.tier.toUpperCase()}`);

  console.log("\n── all tiers miss, AI gated off → clean failure ──");
  try {
    await resolveWithMeta(page, {
      id: "ghost",
      css: ".does-not-exist",
      description: "a button that isn't there",
    });
    console.log("ERROR: should have thrown");
  } catch (e) {
    console.log(`threw as expected: ${(e as Error).message}`);
  }

  console.log(`\nheal-cache size: ${__healCache.size()} (0 — AI never ran; all deterministic)`);
  await browser.close();
  console.log("\n✅ self-healing demonstrated: markup changed, locator survived.\n");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
