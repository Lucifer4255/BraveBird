import { OpenRouter } from "@openrouter/sdk";
import type { Page } from "playwright";
import { config } from "../config.js";

/**
 * Tier 4 of the locator cascade: ask an LLM to find an element when every
 * deterministic strategy has failed. GATED — only runs when AI_LOCATOR_ENABLED.
 *
 * Two deliberate choices that make this cheap and sane:
 *   1. We feed the ACCESSIBILITY TREE (ARIA snapshot), not raw HTML or a
 *      screenshot. It's a fraction of the tokens, deterministic to produce, and
 *      already encodes roles + labels — exactly what's needed to find an element.
 *   2. The caller (locators.ts) caches whatever selector we return, so this
 *      expensive path runs at most once per element ("heal once, then deterministic").
 *
 * Routed via OpenRouter (the `@openrouter/sdk` client) so the model is swappable
 * by config — a cheap flash model by default.
 */

let client: OpenRouter | undefined;

function getClient(): OpenRouter {
  if (!config.ai.apiKey) {
    throw new Error(
      "AI_LOCATOR_ENABLED is true but OPENROUTER_API_KEY is not set — cannot use the Tier-4 resolver.",
    );
  }
  client ??= new OpenRouter({ apiKey: config.ai.apiKey });
  return client;
}

const SYSTEM_PROMPT =
  "You are a web-automation locator resolver. You are given an accessibility " +
  "tree (ARIA snapshot) of a page and a plain-language description of ONE " +
  "element. Reply with a single Playwright-compatible CSS selector that uniquely " +
  "targets that element. Output ONLY the selector — no prose, no explanation, no " +
  "markdown, no backticks.";

/** Strip accidental markdown fences/backticks the model may wrap around the selector. */
function cleanSelector(raw: string): string {
  return raw
    .trim()
    .replace(/^```[a-zA-Z]*\n?/, "")
    .replace(/```$/, "")
    .replace(/^`|`$/g, "")
    .trim();
}

/**
 * Returns a CSS selector string for `description`, or null if the model can't
 * produce a usable one. Never throws for "not found" — only for misconfiguration.
 */
export async function aiResolveSelector(
  page: Page,
  description: string,
): Promise<string | null> {
  // The a11y tree of the page body — compact, role/label-rich input for the model.
  const snapshot = await page.locator("body").ariaSnapshot();

  const result = await getClient().chat.send({
    chatRequest: {
      model: config.ai.model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: `Accessibility tree:\n${snapshot}\n\nElement to locate: ${description}\n\nReturn exactly one CSS selector.`,
        },
      ],
    },
  });

  const raw = result.choices?.[0]?.message?.content;
  if (typeof raw !== "string") return null;

  const selector = cleanSelector(raw);
  return selector.length > 0 ? selector : null;
}
