import { FingerprintGenerator, type BrowserFingerprintWithHeaders } from "fingerprint-generator";
import { newInjectedContext } from "fingerprint-injector";
import type { Browser, BrowserContext } from "playwright";
import { applyStealthScripts, buildContextOptions, buildProxy } from "../core/stealth.js";
import { IDENTITY_PROFILES, type IdentityProfile } from "./profiles.js";

/**
 * Fingerprint source for identity rotation.
 *
 * Two backends behind one interface:
 *   - "generated": Apify `fingerprint-generator` + `fingerprint-injector` —
 *     statistically-real, coherent fingerprints (UA + screen + WebGL + fonts +
 *     hardware), sampled by real-world prevalence and injected at every layer.
 *   - "curated": our 3 hand-written profiles + the manual stealth init — a
 *     zero-dependency fallback that keeps the engine runnable if the library is
 *     unavailable.
 *
 * Each Fingerprint knows how to BUILD ITS OWN CONTEXT (the injection differs per
 * backend) and how to SERIALIZE itself, so identities persist across runs.
 */

export interface CreateContextOptions {
  storageState?: string;
  proxyUrl?: string;
}

export interface Fingerprint {
  readonly kind: "generated" | "curated";
  readonly platform: string;
  readonly timezoneId: string;
  readonly summary: string;
  /** Build a fully fingerprinted, stealthed context for this identity. */
  createContext(browser: Browser, opts?: CreateContextOptions): Promise<BrowserContext>;
  /** Serialize for persistence (durable personas across runs). */
  toJSON(): FingerprintRecord;
}

export type FingerprintRecord =
  | { kind: "generated"; raw: BrowserFingerprintWithHeaders; timezoneId: string }
  | { kind: "curated"; profileId: string };

/** Timezones coherent with a locale (must agree, or it's a bot tell). */
const TZ_BY_LOCALE: Record<string, string> = {
  "en-US": "America/New_York",
  "en-GB": "Europe/London",
  "en-CA": "America/Toronto",
  "en-AU": "Australia/Sydney",
  "fr-FR": "Europe/Paris",
  "de-DE": "Europe/Berlin",
  "es-ES": "Europe/Madrid",
};

function tzForLocale(locale: string): string {
  if (TZ_BY_LOCALE[locale]) return TZ_BY_LOCALE[locale]!;
  const lang = locale.split("-")[0];
  const hit = Object.entries(TZ_BY_LOCALE).find(([k]) => k.startsWith(`${lang}-`));
  return hit ? hit[1] : "America/New_York";
}

/** Wrap a generated fingerprint (uses fingerprint-injector for deep injection). */
export function generatedFingerprint(raw: BrowserFingerprintWithHeaders): Fingerprint {
  const nav = raw.fingerprint.navigator;
  const tz = tzForLocale(nav.language);
  const platform = nav.platform;
  const os = /win/i.test(platform)
    ? "Windows"
    : /mac/i.test(platform)
      ? "macOS"
      : /linux/i.test(platform)
        ? "Linux"
        : platform;
  const chrome = nav.userAgent.match(/Chrome\/(\d+)/)?.[1] ?? "?";
  const { width, height } = raw.fingerprint.screen;

  return {
    kind: "generated",
    platform,
    timezoneId: tz,
    summary: `${os} · Chrome ${chrome} · ${width}x${height}`,
    async createContext(browser, opts = {}) {
      return newInjectedContext(browser, {
        fingerprint: raw,
        newContextOptions: {
          storageState: opts.storageState,
          proxy: buildProxy(opts.proxyUrl),
          timezoneId: tz, // generator doesn't emit a timezone — set one coherent with locale
        },
      });
    },
    toJSON: () => ({ kind: "generated", raw, timezoneId: tz }),
  };
}

/** Wrap a curated profile (uses our manual stealth init). */
export function curatedFingerprint(profile: IdentityProfile): Fingerprint {
  return {
    kind: "curated",
    platform: profile.platform,
    timezoneId: profile.timezoneId,
    summary: profile.id,
    async createContext(browser, opts = {}) {
      const context = await browser.newContext({
        ...buildContextOptions(profile, opts.proxyUrl),
        storageState: opts.storageState,
      });
      await applyStealthScripts(context, profile);
      return context;
    },
    toJSON: () => ({ kind: "curated", profileId: profile.id }),
  };
}

/**
 * Quality gate. The generator draws from real-world data, which has a weird tail:
 * ancient browsers, in-app webviews, datacenter machines, OS-mismatched samples.
 * Injecting those is worse than nothing — we want the *plausible middle*.
 */
function isPlausible(raw: BrowserFingerprintWithHeaders): boolean {
  const nav = raw.fingerprint.navigator;
  const ua = nav.userAgent;
  const { width, height } = raw.fingerprint.screen;
  const cores = nav.hardwareConcurrency;

  // modern desktop screen
  if (width < 1280 || height < 720 || width > 3840 || height > 2160) return false;
  // plausible consumer CPU (not 1, not 384)
  if (!cores || cores < 2 || cores > 32) return false;
  // reject in-app / embedded browsers
  if (/LarkUrl|FBAN|FBAV|Instagram|Line\/|MicroMessenger|Electron|; wv\)/i.test(ua)) return false;
  // OS must agree between navigator.platform and the UA string
  const plat = nav.platform;
  if (/win/i.test(plat) && !/Windows/i.test(ua)) return false;
  if (/mac/i.test(plat) && !/Macintosh|Mac OS/i.test(ua)) return false;
  if (/linux/i.test(plat) && !/Linux|X11/i.test(ua)) return false;
  // modern Chrome only
  if (Number(ua.match(/Chrome\/(\d+)/)?.[1] ?? 0) < 120) return false;

  return true;
}

/** Rebuild a Fingerprint from its persisted record. */
export function fingerprintFromRecord(rec: FingerprintRecord): Fingerprint {
  if (rec.kind === "generated") return generatedFingerprint(rec.raw);
  const profile = IDENTITY_PROFILES.find((p) => p.id === rec.profileId);
  if (!profile) throw new Error(`unknown curated profile "${rec.profileId}"`);
  return curatedFingerprint(profile);
}

/**
 * Produces fingerprints. Prefers the real generator; silently falls back to the
 * curated profiles if the library can't initialize (keeps the engine runnable).
 */
export class FingerprintFactory {
  private gen?: FingerprintGenerator;

  constructor(useGenerated = true) {
    if (useGenerated) {
      try {
        this.gen = new FingerprintGenerator({
          browsers: [{ name: "chrome", minVersion: 120 }],
          devices: ["desktop"],
          operatingSystems: ["windows", "macos"],
        });
      } catch {
        this.gen = undefined; // fall back to curated
      }
    }
  }

  get mode(): "generated" | "curated" {
    return this.gen ? "generated" : "curated";
  }

  create(): Fingerprint {
    if (this.gen) {
      // Sample until we get a plausible one; give up after a cap → curated fallback.
      for (let i = 0; i < 25; i++) {
        const raw = this.gen.getFingerprint();
        if (isPlausible(raw)) return generatedFingerprint(raw);
      }
    }
    const profile = IDENTITY_PROFILES[Math.floor(Math.random() * IDENTITY_PROFILES.length)]!;
    return curatedFingerprint(profile);
  }
}
