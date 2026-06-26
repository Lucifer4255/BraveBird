import type { BrowserContext, BrowserContextOptions } from "playwright";
import { config } from "../config.js";
import type { IdentityProfile } from "../evasion/profiles.js";

/**
 * Stealth layer — makes an automated Chromium look like a normal human browser.
 *
 * Two responsibilities:
 *   1. buildContextOptions() — the "outside" of the browser: user-agent, locale,
 *      viewport, timezone, and (optionally) a proxy. These are set when the
 *      context is created.
 *   2. applyStealthScripts() — the "inside" of the browser: JavaScript patches
 *      injected BEFORE the page's own JS runs, so detection scripts see
 *      human-looking values (navigator.webdriver, plugins, WebGL, ...).
 *
 * Ceiling: these are JS-level evasions. They defeat JS-level checks, not
 * network-layer fingerprints (TLS/JA3). That's what the proxy hook is for.
 */

/**
 * Turn a proxy URL ("http://user:pass@host:port") into Playwright's proxy shape.
 * Returns undefined when no proxy is configured — i.e. run direct.
 *
 * The whole "proxy abstraction": callers pass a proxy URL (or none) and never
 * think about proxy mechanics. The proxy pool (M5) supplies the URL at scale;
 * absent that, it falls back to a single PROXY_URL from config.
 */
export function buildProxy(proxyUrl?: string): BrowserContextOptions["proxy"] {
  const url = proxyUrl ?? config.browser.proxyUrl;
  if (!url) return undefined;

  const parsed = new URL(url);
  return {
    server: `${parsed.protocol}//${parsed.host}`, // host includes port
    username: parsed.username ? decodeURIComponent(parsed.username) : undefined,
    password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
  };
}

/**
 * The "outside" settings, applied when a context is created. Every value comes
 * from ONE coherent identity profile, so nothing is mismatched (a Windows UA
 * with a Mac platform is a worse signal than no spoofing at all).
 */
export function buildContextOptions(
  identity: IdentityProfile,
  proxyUrl?: string,
): BrowserContextOptions {
  return {
    userAgent: identity.userAgent,
    locale: identity.locale,
    timezoneId: identity.timezoneId,
    viewport: identity.viewport,
    deviceScaleFactor: identity.deviceScaleFactor,
    extraHTTPHeaders: { "Accept-Language": identity.acceptLanguage },
    proxy: buildProxy(proxyUrl),
  };
}

/**
 * The "inside" patches. Injected via addInitScript so they run before any page
 * script — we win the race, the detector only ever sees the patched values.
 *
 * IMPORTANT: this is written as a STRING, not a function. A function passed here
 * would be compiled by tsx/esbuild first — which injects Node-only helpers (e.g.
 * `__name`) that don't exist in the browser and throw ReferenceError. A string is
 * shipped verbatim, so what we write is exactly what runs. (Learned this the hard
 * way: the function form silently no-op'd every patch.)
 */
function buildStealthInitSource(identity: IdentityProfile): string {
  // Languages must agree with the identity's locale: en-US → ["en-US","en"].
  const languages = [identity.locale, identity.locale.split("-")[0]].filter(
    (v, i, a) => v && a.indexOf(v) === i,
  );

  return /* js */ `
(() => {
  // Each patch is isolated: one failing must NOT abort the rest.
  const safe = (fn) => { try { fn(); } catch (e) {} };

  // 1. Hide the automation flag. Real browsers report false (or undefined).
  safe(() => Object.defineProperty(navigator, 'webdriver', { get: () => false, configurable: true }));

  // 2. Fake a non-empty plugins array (headless browsers have none).
  safe(() => Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5], configurable: true }));

  // 3. Languages — coherent with this identity's locale.
  safe(() => Object.defineProperty(navigator, 'languages', { get: () => ${JSON.stringify(languages)}, configurable: true }));

  // 4. Platform — MUST match the UA's OS (driven by the identity profile).
  safe(() => Object.defineProperty(navigator, 'platform', { get: () => ${JSON.stringify(identity.platform)}, configurable: true }));

  // 5. window.chrome exists in real Chrome but often not when automated.
  safe(() => {
    if (!window.chrome) {
      Object.defineProperty(window, 'chrome', { value: { runtime: {} }, configurable: true });
    }
  });

  // 6. Spoof the WebGL vendor/renderer so it reports a real GPU, not SwiftShader.
  safe(() => {
    const getParameter = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function (parameter) {
      if (parameter === 37445) return 'Intel Inc.';              // UNMASKED_VENDOR_WEBGL
      if (parameter === 37446) return 'Intel Iris OpenGL Engine'; // UNMASKED_RENDERER_WEBGL
      return getParameter.call(this, parameter);
    };
  });

  // 7. Make permissions.query behave like a real browser for notifications.
  safe(() => {
    const originalQuery = window.navigator.permissions.query.bind(window.navigator.permissions);
    window.navigator.permissions.query = (parameters) =>
      parameters.name === 'notifications'
        ? Promise.resolve({ state: Notification.permission })
        : originalQuery(parameters);
  });
})();
`;
}

export async function applyStealthScripts(
  context: BrowserContext,
  identity: IdentityProfile,
): Promise<void> {
  await context.addInitScript({ content: buildStealthInitSource(identity) });
}

/**
 * Browser-launch flags that help at the process level. The first one is the
 * cleanest webdriver fix of all — it tells Chromium not to advertise that it's
 * being controlled, so the flag never gets set in the first place.
 */
export const STEALTH_LAUNCH_ARGS = [
  "--disable-blink-features=AutomationControlled",
  "--no-sandbox",
  "--disable-dev-shm-usage",
];
