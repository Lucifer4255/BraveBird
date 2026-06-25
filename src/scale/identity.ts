/**
 * Identity / fingerprint rotation for scale.
 *
 * The core rule: a fingerprint must be INTERNALLY COHERENT. A Windows UA paired
 * with a MacIntel platform and a Tokyo timezone is a stronger bot signal than no
 * spoofing at all. So we rotate whole *profiles*, never individual fields.
 *
 *   - one profile = a self-consistent human (UA + platform + viewport + TZ + locale)
 *   - sticky per session: a visitor's fingerprint must not change mid-session
 *   - ban/retire a profile when it gets burned, hand out a fresh one
 */

export interface IdentityProfile {
  /** Stable id for stickiness + ban tracking. */
  id: string;
  userAgent: string;
  /** navigator.platform — MUST match the UA's OS. */
  platform: string;
  viewport: { width: number; height: number };
  deviceScaleFactor: number;
  locale: string; // e.g. "en-US"
  timezoneId: string; // e.g. "America/New_York"
  /** Accept-Language header — should agree with `locale`. */
  acceptLanguage: string;
}

/**
 * A small curated pool of COHERENT desktop profiles. Each row is a plausible
 * real machine; nothing is mismatched. At true scale this would be generated
 * from a fingerprint dataset, but the coherence rule is the same.
 */
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

/**
 * Hands out identities, keeps them sticky by key, and retires burned ones.
 *
 *   const pool = new IdentityPool();
 *   const id = pool.acquire("session-42");   // sticky: same key → same identity
 *   ...
 *   pool.ban(id.id);                          // burned → never handed out again
 */
export class IdentityPool {
  private readonly profiles: IdentityProfile[];
  private readonly banned = new Set<string>();
  /** key → assigned profile id (stickiness). */
  private readonly assignments = new Map<string, string>();
  private cursor = 0;

  constructor(profiles: readonly IdentityProfile[] = IDENTITY_PROFILES) {
    if (profiles.length === 0) throw new Error("IdentityPool needs at least one profile");
    this.profiles = [...profiles];
  }

  /**
   * Get an identity. If `key` is given, the same key returns the same identity
   * (sticky session) until that identity is banned, then it's reassigned.
   */
  acquire(key?: string): IdentityProfile {
    if (key) {
      const existing = this.assignments.get(key);
      if (existing && !this.banned.has(existing)) {
        return this.byId(existing);
      }
    }
    const profile = this.nextHealthy();
    if (key) this.assignments.set(key, profile.id);
    return profile;
  }

  /** Retire a burned identity so it's never handed out again. */
  ban(id: string): void {
    this.banned.add(id);
  }

  /** Round-robin over non-banned profiles. */
  private nextHealthy(): IdentityProfile {
    for (let i = 0; i < this.profiles.length; i++) {
      const profile = this.profiles[this.cursor % this.profiles.length]!;
      this.cursor++;
      if (!this.banned.has(profile.id)) return profile;
    }
    throw new Error("IdentityPool exhausted — every profile is banned");
  }

  private byId(id: string): IdentityProfile {
    const found = this.profiles.find((p) => p.id === id);
    if (!found) throw new Error(`unknown identity "${id}"`);
    return found;
  }

  get healthyCount(): number {
    return this.profiles.filter((p) => !this.banned.has(p.id)).length;
  }
}
