import { BrowserManager } from "../core/browserManager.js";
import type { Job } from "../workflows/base.js";
import { type BookingResult, BookingWorkflow } from "../workflows/booking.js";

/**
 * Find the best-rated, under-budget hotel for a stay (fetch price — does NOT book).
 *   npm run booking
 */
async function main() {
  const bm = new BrowserManager();
  await bm.start();

  const wf = new BookingWorkflow();
  const job: Job = {
    id: "find-hotel-goa",
    site: "booking",
    params: {
      destination: "Goa",
      checkin: "2026-06-26",
      checkout: "2026-06-29", // 3 nights
      adults: 3,
      maxTotalPrice: 15_000, // ₹ total for the stay
      minRating: 8.0,
      currency: "INR",
    },
  };
  const p = job.params as { destination: string; adults: number; maxTotalPrice: number; minRating: number };

  const ctx = await bm.acquireContext({ sessionKey: job.id });
  console.log(`identity : ${bm.identityFor(ctx)?.fingerprint.summary}`);
  console.log(`searching: ${p.destination} · 3 nights · ${p.adults} adults · rating ≥ ${p.minRating} · budget ≤ ₹${p.maxTotalPrice.toLocaleString("en-IN")}`);

  try {
    const r = (await wf.run(ctx, job)) as BookingResult;
    bm.recordSuccess(ctx);
    await bm.persistSession(ctx);

    console.log(`\nscanned ${r.scanned} hotels · ${r.qualified} matched (rating ≥ ${r.minRating}, ≤ ₹${r.budget.toLocaleString("en-IN")})`);
    if (r.best) {
      console.log(`\n🏆 BEST: ${r.best.name}`);
      console.log(`        rating ${r.best.rating}/10 · ${r.best.priceText} total · ${r.nights} nights · ${r.adults} adults`);
      if (r.top.length > 1) {
        console.log(`\nrunners-up:`);
        for (const h of r.top.slice(1)) console.log(`  - ${h.name} (${h.rating}/10) ${h.priceText}`);
      }
    } else {
      console.log(`\nNo hotel matched rating ≥ ${r.minRating} under ₹${r.budget.toLocaleString("en-IN")}. Loosen the budget or rating.`);
    }
  } catch (err) {
    if ((err as Error)?.name === "BotWallError") bm.recordBlock(ctx);
    throw err;
  } finally {
    await bm.releaseContext(ctx);
    await bm.stop();
  }
}

main().catch((err) => {
  console.error("\n❌ FAILED:", err?.name === "BotWallError" ? err.message : err);
  process.exit(1);
});
