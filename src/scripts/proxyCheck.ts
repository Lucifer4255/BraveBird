import { chromium } from "playwright";
import { FingerprintFactory } from "../evasion/fingerprint.js";
import { ProxyPool } from "../evasion/proxyPool.js";

/** Verify M5 — proxy pool logic + that the proxy is really applied. */
async function main() {
  const pool = new ProxyPool({
    entries: [
      "http://u:p@us1.example:8000|US|America/New_York",
      "http://u:p@us2.example:8000|US|America/New_York",
      "http://u:p@uk1.example:8000|GB|Europe/London",
    ],
    cooldownMs: 200,
    maxBlocks: 2,
  });
  console.log(`pool size: ${pool.size} | healthy: ${pool.healthyCount}`);

  console.log("\n── rotation (least-recently-used) ──");
  console.log("  " + [pool.acquire(), pool.acquire(), pool.acquire()].join("\n  "));

  console.log("\n── stickiness (same key → same proxy) ──");
  const a = pool.acquire("job-A");
  const a2 = pool.acquire("job-A");
  console.log(`  job-A: ${a === a2 ? "✅ stable" : "❌ changed"}`);

  console.log("\n── geo-coherence (UK-timezone identity prefers UK proxy) ──");
  const uk = pool.acquire("job-UK", "Europe/London");
  console.log(`  got ${uk} → ${/uk1/.test(uk ?? "") ? "✅ matched region" : "❌"}`);

  console.log("\n── cooldown + retire (maxBlocks=2) ──");
  const us1 = "http://u:p@us1.example:8000";
  pool.reportBlocked(us1);
  console.log(`  after 1 block: healthy=${pool.healthyCount} (us1 cooling down)`);
  pool.reportBlocked(us1); // 2nd block → retire
  await new Promise((r) => setTimeout(r, 250)); // wait out the cooldown
  const seen = new Set<string | undefined>();
  for (let i = 0; i < 6; i++) seen.add(pool.acquire(`k${i}`));
  const retired = ![...seen].some((u) => u?.includes("us1"));
  console.log(`  us1 retired, never reused: ${retired ? "✅" : "❌"} | healthy=${pool.healthyCount}`);

  console.log("\n── empty pool → run direct (undefined) ──");
  console.log(`  ${new ProxyPool({ entries: [] }).acquire() ?? "undefined ✅"}`);

  console.log("\n── wiring: a bogus proxy is actually USED by Playwright ──");
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-blink-features=AutomationControlled"],
  });
  const fp = new FingerprintFactory().create();
  const ctx = await fp.createContext(browser, { proxyUrl: "http://127.0.0.1:9" }); // nothing there
  const page = await ctx.newPage();
  let proxied = false;
  try {
    await page.goto("https://example.com", { timeout: 8000 });
  } catch (e) {
    const msg = (e as Error).message.split("\n")[0]!;
    proxied = /ERR_PROXY|ERR_TUNNEL|ERR_SOCKS|proxy/i.test(msg);
    console.log("  nav error:", msg);
  }
  console.log(`  proxy applied: ${proxied ? "✅ (traffic went through the proxy and failed as expected)" : "❌ (page loaded — proxy NOT used)"}`);
  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
