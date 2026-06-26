import { BrowserManager } from "../core/browserManager.js";
import type { Job } from "../workflows/base.js";
import { BookingWorkflow } from "../workflows/booking.js";

/**
 * Run a single Booking.com job end-to-end (manual M3 verification).
 *
 *   npx tsx src/scripts/runBooking.ts
 *   HEADLESS=false npx tsx src/scripts/runBooking.ts
 */
async function main() {
  const bm = new BrowserManager();
  await bm.start();

  const wf = new BookingWorkflow();
  const job: Job = {
    id: "booking-demo-1",
    site: "booking",
    params: { destination: "Goa", checkin: "2026-06-26", checkout: "2026-06-28", adults: 2 },
  };

  // Sticky identity per job — its persona + session are loaded automatically.
  const ctx = await bm.acquireContext({ sessionKey: job.id });
  const identity = bm.identityFor(ctx);
  console.log(`identity: ${identity?.id} (${identity?.fingerprint.summary})`);

  try {
    const result = await wf.run(ctx, job);
    bm.recordSuccess(ctx);
    await bm.persistSession(ctx); // persona accumulates session history
    console.log("\n✅ RESULT:\n" + JSON.stringify(result, null, 2));
  } catch (err) {
    if ((err as Error)?.name === "BotWallError") bm.recordBlock(ctx);
    throw err;
  } finally {
    await bm.releaseContext(ctx);
    await bm.stop();
    console.log(`\nopen contexts after teardown: ${bm.openContextCount} (want 0)`);
  }
}

main().catch((err) => {
  console.error("\n❌ FAILED:", err?.name === "BotWallError" ? err.message : err);
  process.exit(1);
});
