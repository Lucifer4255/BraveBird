import { existsSync } from "node:fs";
import { BrowserManager } from "../core/browserManager.js";
import { BookingWorkflow } from "../workflows/booking.js";
import type { Job } from "../workflows/base.js";

/**
 * Run a single Booking.com job end-to-end (manual M3 verification).
 *
 *   npx tsx src/scripts/runBooking.ts
 *   HEADLESS=false npx tsx src/scripts/runBooking.ts   (watch it)
 */
async function main() {
  const bm = new BrowserManager();
  await bm.start();

  const wf = new BookingWorkflow();
  const job: Job = {
    id: "booking-demo-1",
    site: "booking",
    params: {
      destination: "Goa",
      checkin: "2026-06-26",
      checkout: "2026-06-28",
      adults: 2,
    },
  };

  // Reuse a saved session if one exists (skip-warm-up demo); sticky identity per job.
  const sessionFile = wf.sessionPath(job);
  const ctx = await bm.acquireContext({
    storageState: existsSync(sessionFile) ? sessionFile : undefined,
    sessionKey: job.id,
  });

  try {
    const result = await wf.run(ctx, job);
    console.log("\n✅ RESULT:\n" + JSON.stringify(result, null, 2));
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
