import type { BrowserContext, Page } from "playwright";

/**
 * Raised when a bot wall / anti-automation challenge blocks the page. Treated as
 * a FIRST-CLASS failure (not a bug to brute-force): the worker catches it,
 * telemetry captures evidence, and the job fails cleanly.
 */
export class BotWallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BotWallError";
  }
}

/**
 * A unit of work handed to the worker. Site-agnostic: the worker reads `site`
 * to pick a Workflow, and passes `params` straight through to it.
 */
export interface Job {
  id: string;
  site: string;
  params: Record<string, unknown>;
}

/**
 * Base class for every site workflow (Template Method pattern).
 *
 * `run()` owns the FIXED skeleton every job follows — session check, login,
 * persist, navigate, extract — and guarantees the order. Each site subclass
 * fills in the site-specific steps. The worker only ever calls `run()`; it knows
 * nothing about any particular website. Adding a site = one new subclass.
 */
export abstract class Workflow {
  /** Stable site key the worker matches a job against (e.g. "booking"). */
  abstract readonly site: string;

  /** Where this job's session (cookies/storage) is persisted on disk. */
  abstract sessionPath(job: Job): string;

  /**
   * Land on the site: navigate to the entry URL, dismiss consent banners, and
   * detect a bot wall. Runs first so the session check below has a real page to
   * inspect. Should throw a recognisable error if a bot wall is hit.
   */
  protected abstract open(page: Page, job: Job): Promise<void>;

  /**
   * Is the current session usable/logged-in? Loaded from storageState, this is
   * a CHECK, not an assumption — sessions expire. Subclasses verify something
   * concrete (an account menu, a usable search box, not a bot wall).
   */
  protected abstract isLoggedIn(page: Page): Promise<boolean>;

  /** Perform login and follow any post-login redirect. */
  protected abstract login(page: Page, job: Job): Promise<void>;

  /** Deep-navigate to the target interface and fill the form. */
  protected abstract navigate(page: Page, job: Job): Promise<void>;

  /** Read the structured result out of the page (or its XHR). */
  protected abstract extract(page: Page, job: Job): Promise<unknown>;

  /**
   * The fixed skeleton. Note the order and the session discipline: we only log
   * in when the loaded session isn't valid, and we re-snapshot storageState
   * right after a fresh login so the NEXT run can skip it.
   */
  async run(context: BrowserContext, job: Job): Promise<unknown> {
    const page = await context.newPage();

    // 1. Land on the site (consent + bot-wall handling live here).
    await this.open(page, job);

    // 2. Session check, not assumption. Log in only if the loaded session is stale.
    if (!(await this.isLoggedIn(page))) {
      await this.login(page, job);
      // Persist the freshly authenticated session for next time.
      // indexedDB:true captures sites that stash auth there, not just cookies.
      await context.storageState({ path: this.sessionPath(job), indexedDB: true });
    }

    // 3. Deep-navigate + fill the form. 4. Extract.
    await this.navigate(page, job);
    return this.extract(page, job);
  }
}
