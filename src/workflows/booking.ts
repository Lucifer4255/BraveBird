import type { Page } from "playwright";
import { resolve, resolveWithMeta } from "../core/locators.js";
import { classify } from "../evasion/classifier.js";
import { BotWallError, type Job, Workflow } from "./base.js";

/**
 * Booking.com workflow — the showcase for deep navigation + dynamic forms +
 * bot-wall handling.
 *
 * Scope note (honest): Booking's account login is email-OTP, which can't be
 * automated headlessly, so we do NOT do account login here. Booking demonstrates
 * the hard dynamic-form flow (autocomplete, dependent date picker, occupancy
 * stepper) and session persistence via storageState (cookies/consent/challenge
 * token). Clean username/password login + skip-login lives in the SauceDemo
 * workflow.
 *
 * Every interaction follows: find → wait → act → verify.
 */
export interface BookingParams {
  destination: string;
  checkin: string; // YYYY-MM-DD
  checkout: string; // YYYY-MM-DD
  adults: number;
}

export interface BookingResult {
  destination: string;
  resultsUrl: string;
  propertyCount: number;
  sample: string[];
}

export class BookingWorkflow extends Workflow {
  readonly site = "booking";

  /** Land on Booking, classify the response, dismiss consent. */
  protected async open(page: Page, _job: Job): Promise<void> {
    const response = await page.goto("https://www.booking.com/", {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });

    // First-class anti-bot handling: a block/captcha is a recognised failure the
    // worker reacts to (burn identity+proxy, retry fresh), not a bug to push through.
    const result = await classify(page, response);
    if (result.verdict === "blocked") {
      throw new BotWallError(`Booking blocked: ${result.reason}`);
    }
    if (result.verdict === "captcha") {
      throw new BotWallError(`Booking captcha (${result.captcha?.kind}): ${result.reason}`);
    }
    // "challenge" usually auto-passes; "ok" proceeds.

    await this.dismissConsent(page);
  }

  /**
   * Booking uses OTP login we don't automate, so the search flow needs no auth —
   * report "logged in" to skip the login step entirely.
   */
  protected async isLoggedIn(_page: Page): Promise<boolean> {
    return true;
  }

  /** No-op: see scope note above. */
  protected async login(_page: Page, _job: Job): Promise<void> {
    /* Booking account login (email OTP) is out of scope — see class docstring. */
  }

  /** The dynamic-form showcase: destination → dates → guests → search. */
  protected async navigate(page: Page, job: Job): Promise<void> {
    const p = job.params as unknown as BookingParams;

    await this.fillDestination(page, p.destination);
    await this.pickDates(page, p.checkin, p.checkout);
    await this.setAdults(page, p.adults);
    await this.submitSearch(page);
  }

  /** Read structured results (prefer DOM cards; could also read the results XHR). */
  protected async extract(page: Page, job: Job): Promise<BookingResult> {
    const p = job.params as unknown as BookingParams;

    const cards = page.locator("[data-testid='property-card']");
    await cards.first().waitFor({ state: "visible", timeout: 30_000 }).catch(() => {});

    const count = await cards.count();
    const sample = await cards
      .locator("[data-testid='title']")
      .allInnerTexts()
      .catch(() => []);

    return {
      destination: p.destination,
      resultsUrl: page.url(),
      propertyCount: count,
      sample: sample.slice(0, 5),
    };
  }

  // ── step helpers (each: find → wait → act → verify) ──────────────────────

  private async fillDestination(page: Page, destination: string): Promise<void> {
    // FIND — placeholder is the stable anchor (recon confirmed), css as fallback.
    const input = await resolveWithMeta(
      page,
      {
        id: "booking-destination",
        placeholder: /where are you going/i,
        css: "input[name='ss']",
        description: "the destination / 'where are you going' search input",
      },
      { timeout: 20_000 }, // search box renders after domcontentloaded
    );
    // Booking pops a sign-in / Genius modal that steals focus mid-type, killing
    // the autocomplete. The human fix (observed): close the modal and type again.
    // So: type → if no suggestions, dismiss the modal and RETRY a few times.
    const options = page.locator("[data-testid='autocomplete-result']");
    for (let attempt = 1; attempt <= 3; attempt++) {
      await this.dismissModals(page);

      // ACT — real keystrokes (fill() in one shot often doesn't trip the
      // keystroke-debounced autocomplete).
      await input.locator.click().catch(() => {});
      await input.locator.fill("").catch(() => {});
      await input.locator.pressSequentially(destination, { delay: 60 });

      try {
        // WAIT — for the OPTIONS to render, never sleep().
        await options.first().waitFor({ state: "visible", timeout: 8_000 });
        // Prefer the suggestion matching the destination text, else the first.
        // Clicking a suggestion is what registers Booking's dest_id.
        const matching = options.filter({ hasText: new RegExp(destination, "i") }).first();
        const target = (await matching.count()) > 0 ? matching : options.first();
        await target.click();
        return; // VERIFY — a clicked suggestion is the success signal.
      } catch {
        // No suggestions — a modal likely grabbed focus. Close it and try again.
        await this.dismissModals(page);
      }
    }

    // Still nothing after dismiss+retry — the degraded/bot-detected variant.
    // Treat as a soft block so detect-and-react ROTATES identity+proxy.
    throw new BotWallError(
      `destination autocomplete unavailable for "${destination}" after retries (degraded variant)`,
    );
  }

  /** Close any sign-in / Genius / promo modal that can intercept the search box. */
  private async dismissModals(page: Page): Promise<void> {
    const closers = [
      'button[aria-label*="Dismiss" i]',
      'button[aria-label*="Close" i]',
      '[role="dialog"] button[aria-label*="dismiss" i]',
      '[role="dialog"] [aria-label*="Close" i]',
    ];
    for (const selector of closers) {
      const btn = page.locator(selector).first();
      if (await btn.count().catch(() => 0)) {
        await btn.click({ timeout: 1_500 }).catch(() => {});
      }
    }
    // Escape closes most Booking modals as a fallback.
    await page.keyboard.press("Escape").catch(() => {});
  }

  private async pickDates(page: Page, checkin: string, checkout: string): Promise<void> {
    // Best-effort: Booking serves variant calendars to suspected automation, so
    // this must degrade gracefully (the search still works with default dates).
    try {
      // `:visible` dodges Booking's duplicate hidden (mobile) calendar.
      const checkinCell = page.locator(`[data-date='${checkin}']:visible`).first();

      // Open the calendar only if the day cells aren't already showing (selecting
      // a destination can auto-open it; clicking again would toggle it shut).
      if ((await checkinCell.count()) === 0) {
        const dateField = await resolve(
          page,
          {
            id: "booking-date-field",
            css: "[data-testid='date-display-field-start']",
            description: "the check-in date field",
          },
          { timeout: 15_000 },
        );
        await dateField.click();
      }

      await checkinCell.waitFor({ state: "visible", timeout: 15_000 });
      await checkinCell.click(); // ACT — check-in

      // Checkout only becomes selectable AFTER check-in (dependent field).
      const checkoutCell = page.locator(`[data-date='${checkout}']:visible`).first();
      await checkoutCell.waitFor({ state: "visible", timeout: 15_000 });
      await checkoutCell.click(); // ACT — check-out
    } catch (err) {
      console.warn(`[booking] date step skipped (variant calendar): ${(err as Error).message}`);
    }
  }

  private async setAdults(page: Page, adults: number): Promise<void> {
    // Booking defaults to 2 adults; only act if a different count is requested.
    try {
      const trigger = await resolve(
        page,
        {
          id: "booking-occupancy",
          css: "[data-testid='occupancy-config']",
          description: "the guests / occupancy selector",
        },
        { timeout: 10_000 },
      );
      await trigger.click();

      const adultsInput = page.locator("#group_adults");
      await adultsInput.waitFor({ state: "visible", timeout: 8_000 });

      // Step toward the target with the +/- buttons next to the adults counter.
      for (let guard = 0; guard < 10; guard++) {
        const current = Number(await adultsInput.inputValue().catch(() => "2"));
        if (current === adults) break;
        const dir = current < adults ? "Increase" : "Decrease";
        const btn = page.getByRole("button", { name: new RegExp(`${dir}.*adult`, "i") }).first();
        if ((await btn.count()) === 0) break; // labels may be localized — bail gracefully
        await btn.click();
      }

      // VERIFY (best-effort) — log mismatch but don't fail the whole job on it.
      const finalCount = Number(await adultsInput.inputValue().catch(() => "0"));
      if (finalCount !== adults) {
        console.warn(`[booking] adults wanted ${adults}, got ${finalCount} (stepper labels may differ)`);
      }
    } catch (err) {
      console.warn(`[booking] occupancy step skipped: ${(err as Error).message}`);
    }
  }

  private async submitSearch(page: Page): Promise<void> {
    const submit = await resolve(
      page,
      {
        id: "booking-search-submit",
        css: "button[type='submit']",
        description: "the Search submit button",
      },
      { timeout: 10_000 },
    );
    // ACT + WAIT — click and wait for the results page to load.
    await Promise.all([
      page.waitForURL(/searchresults/i, { timeout: 30_000 }).catch(() => {}),
      submit.click(),
    ]);
  }

  // ── guards / banners ─────────────────────────────────────────────────────

  private async dismissConsent(page: Page): Promise<void> {
    // Consent may or may not appear (recon saw none). Try briefly, never block.
    const accept = page.locator("#onetrust-accept-btn-handler");
    if (await accept.count()) {
      await accept.click({ timeout: 3_000 }).catch(() => {});
    }
  }
}
