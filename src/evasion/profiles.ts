/**
 * Curated, hand-written identity profiles — the zero-dependency fallback used
 * when the statistical fingerprint generator is unavailable. Each is a coherent
 * real machine (UA + platform + viewport + timezone + locale all agree).
 *
 * The scale-grade path is `fingerprint.ts` (real generator); this is the safety
 * net so the engine always runs.
 */
export interface IdentityProfile {
  id: string;
  userAgent: string;
  /** navigator.platform — MUST match the UA's OS. */
  platform: string;
  viewport: { width: number; height: number };
  deviceScaleFactor: number;
  locale: string;
  timezoneId: string;
  acceptLanguage: string;
}

export const IDENTITY_PROFILES: readonly IdentityProfile[] = [
  {
    id: "win10-chrome131",
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    platform: "Win32",
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 1,
    locale: "en-US",
    timezoneId: "America/New_York",
    acceptLanguage: "en-US,en;q=0.9",
  },
  {
    id: "mac-chrome131",
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    platform: "MacIntel",
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    locale: "en-US",
    timezoneId: "America/Los_Angeles",
    acceptLanguage: "en-US,en;q=0.9",
  },
  {
    id: "win11-chrome130-gb",
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    platform: "Win32",
    viewport: { width: 1366, height: 768 },
    deviceScaleFactor: 1,
    locale: "en-GB",
    timezoneId: "Europe/London",
    acceptLanguage: "en-GB,en;q=0.9",
  },
];
