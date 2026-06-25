import type { Locator, Page } from "playwright";
import { config } from "../config.js";
import { aiResolveSelector } from "./aiResolver.js";

/**
 * Self-healing locator cascade.
 *
 * An element is described by SEVERAL identities (role, label, placeholder, text,
 * css). We try them cheapest-and-most-stable first; the first that matches wins.
 * If a redesign breaks the css, the semantic tiers still find it — the locator
 * heals itself.
 *
 *   Tier 0  cache       — a previously AI-healed selector (deterministic, ~instant)
 *   Tier 1  role        — getByRole (meaning/accessibility — most stable)
 *   Tier 2  label       — getByLabel (stable anchor for form inputs)
 *   Tier 3  placeholder — getByPlaceholder (stable for inputs)
 *   Tier 4  text        — getByText (visible copy)
 *   Tier 5  css         — raw selector (brittle, last deterministic resort)
 *   Tier 6  ai          — LLM reads the a11y tree → selector (GATED, off by default)
 *
 * The AI tier "heals once": its selector is cached back to Tier 0, so subsequent
 * lookups are deterministic and free. At scale, paying 1–3s + per-call cost on
 * every lookup is unacceptable — so we pay it at most once per element.
 */

/** Playwright's role type, derived so we don't hand-maintain the huge union. */
type Role = Parameters<Page["getByRole"]>[0];

export interface LocatorSpec {
  /** Logical, stable name for this element. Used as the heal-cache key. */
  id: string;
  /** Tier 1: ARIA role + (optional) accessible name. */
  role?: { type: Role; name?: string | RegExp };
  /** Tier 2: associated <label> text — the stable anchor for form inputs. */
  label?: string | RegExp;
  /** Tier 3: placeholder text — also very stable for inputs. */
  placeholder?: string | RegExp;
  /** Tier 4: visible text. */
  text?: string | RegExp;
  /** Tier 5: a CSS selector (allowed to be brittle — it's the fallback, not the bet). */
  css?: string;
  /** Tier 6: natural-language description fed to the AI resolver when all else fails. */
  description?: string;
}

export type ResolveTier =
  | "cache"
  | "role"
  | "label"
  | "placeholder"
  | "text"
  | "css"
  | "ai";

export interface ResolveResult {
  locator: Locator;
  tier: ResolveTier;
}

/** id → AI-healed CSS selector. Module-level so it survives across lookups. */
const healedCache = new Map<string, string>();

/** Return the first match if the locator resolves to ≥1 element, else null. */
async function firstHit(locator: Locator): Promise<Locator | null> {
  return (await locator.count()) > 0 ? locator.first() : null;
}

export interface ResolveOptions {
  /**
   * If set, poll the deterministic tiers until one matches or this many ms
   * elapse. Dynamic pages render elements late — a one-shot check is a bug.
   * Default 0 = single pass (fine for static content / fixtures).
   */
  timeout?: number;
}

/** One pass through the deterministic tiers (cache → role → label → placeholder → text → css). */
async function tryDeterministic(
  page: Page,
  spec: LocatorSpec,
): Promise<ResolveResult | null> {
  // Tier 0 — cache. Once AI healed this id, every later lookup is deterministic.
  const cached = healedCache.get(spec.id);
  if (cached) {
    const hit = await firstHit(page.locator(cached));
    if (hit) return { locator: hit, tier: "cache" };
  }

  // Tier 1 — role/aria (most stable: tied to meaning, not markup).
  if (spec.role) {
    const loc =
      spec.role.name !== undefined
        ? page.getByRole(spec.role.type, { name: spec.role.name, exact: false })
        : page.getByRole(spec.role.type);
    const hit = await firstHit(loc);
    if (hit) return { locator: hit, tier: "role" };
  }

  // Tier 2 — label (stable anchor for form inputs).
  if (spec.label) {
    const hit = await firstHit(page.getByLabel(spec.label, { exact: false }));
    if (hit) return { locator: hit, tier: "label" };
  }

  // Tier 3 — placeholder (also stable for inputs).
  if (spec.placeholder) {
    const hit = await firstHit(page.getByPlaceholder(spec.placeholder, { exact: false }));
    if (hit) return { locator: hit, tier: "placeholder" };
  }

  // Tier 4 — visible text.
  if (spec.text) {
    const hit = await firstHit(page.getByText(spec.text));
    if (hit) return { locator: hit, tier: "text" };
  }

  // Tier 5 — css/xpath (brittle, but a fine last deterministic resort).
  if (spec.css) {
    const hit = await firstHit(page.locator(spec.css));
    if (hit) return { locator: hit, tier: "css" };
  }

  return null;
}

/**
 * Resolve a spec to a Locator, reporting which tier won (useful for telemetry
 * and the verification script). Polls the deterministic tiers for up to
 * `opts.timeout` ms (for late-rendering content), then falls back to the gated
 * AI tier, then throws a clear error.
 */
export async function resolveWithMeta(
  page: Page,
  spec: LocatorSpec,
  opts: ResolveOptions = {},
): Promise<ResolveResult> {
  const deadline = Date.now() + (opts.timeout ?? 0);

  // Deterministic tiers, retried until the deadline — "most bugs live in wait".
  for (;;) {
    const det = await tryDeterministic(page, spec);
    if (det) return det;
    if (Date.now() >= deadline) break;
    await page.waitForTimeout(250);
  }

  // Tier 6 — AI resolver. Gated OFF by default; heals once, then caches.
  if (config.ai.enabled && spec.description) {
    const selector = await aiResolveSelector(page, spec.description);
    if (selector) {
      const hit = await firstHit(page.locator(selector));
      if (hit) {
        healedCache.set(spec.id, selector); // heal once → deterministic forever
        return { locator: hit, tier: "ai" };
      }
    }
  }

  const deterministic = ["role", "label", "placeholder", "text", "css"] as const;
  const tried: string[] = deterministic.filter((t) => spec[t] !== undefined);
  if (config.ai.enabled && spec.description) tried.push("ai");
  throw new Error(
    `Could not resolve locator "${spec.id}" by any strategy (tried: ${tried.join(", ") || "none"}).`,
  );
}

/** Convenience: just the Locator, for normal workflow code. */
export async function resolve(
  page: Page,
  spec: LocatorSpec,
  opts?: ResolveOptions,
): Promise<Locator> {
  return (await resolveWithMeta(page, spec, opts)).locator;
}

/** Test/telemetry helpers. */
export const __healCache = {
  clear: () => healedCache.clear(),
  size: () => healedCache.size,
  get: (id: string) => healedCache.get(id),
};
