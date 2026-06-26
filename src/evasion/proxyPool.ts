import { config } from "../config.js";

/**
 * Proxy pool for scale.
 *
 * Fingerprint rotation gives each browser a different face; the proxy pool gives
 * each a different IP/network. Rules baked in:
 *   - sticky-per-identity: a persona keeps its address (no mid-session IP swap)
 *   - geo-coherence: prefer a proxy whose region matches the identity's timezone
 *   - cooldown + retire: rest a blocked IP; retire it if repeatedly burned
 *   - empty pool → run direct (returns undefined, never throws)
 *
 * Entry format (from PROXY_URLS): "http://user:pass@host:port" optionally with
 * geo tags "|COUNTRY|Timezone", e.g. "http://u:p@host:port|US|America/New_York".
 */

export interface ProxyEntry {
  url: string;
  country?: string;
  timezoneId?: string;
  blocks: number;
  cooldownUntil: number; // epoch ms; unavailable until then
  lastUsedAt: number;
  retired: boolean;
}

export interface ProxyPoolOptions {
  entries?: string[]; // raw "url" or "url|COUNTRY|TZ"
  cooldownMs?: number; // rest period after a block
  maxBlocks?: number; // retire after this many blocks
}

function parseEntry(raw: string): ProxyEntry {
  const [url, country, timezoneId] = raw.split("|").map((s) => s.trim());
  return {
    url: url!,
    country: country || undefined,
    timezoneId: timezoneId || undefined,
    blocks: 0,
    cooldownUntil: 0,
    lastUsedAt: 0,
    retired: false,
  };
}

export class ProxyPool {
  private readonly proxies: ProxyEntry[];
  private readonly assignments = new Map<string, string>(); // sticky key → proxy url
  private readonly cooldownMs: number;
  private readonly maxBlocks: number;

  constructor(opts: ProxyPoolOptions = {}) {
    const entries = opts.entries ?? config.browser.proxyUrls;
    this.proxies = entries.map(parseEntry);
    this.cooldownMs = opts.cooldownMs ?? 5 * 60_000; // 5 min
    this.maxBlocks = opts.maxBlocks ?? 3;
  }

  get size(): number {
    return this.proxies.length;
  }

  get healthyCount(): number {
    return this.proxies.filter((p) => this.isAvailable(p)).length;
  }

  private isAvailable(p: ProxyEntry): boolean {
    return !p.retired && p.cooldownUntil <= Date.now();
  }

  /**
   * Get a proxy URL for a job. Sticky per `key`; with `preferTimezone`, prefers a
   * geo-coherent proxy. Returns undefined when the pool is empty or nothing is
   * currently available → caller runs direct.
   */
  acquire(key?: string, preferTimezone?: string): string | undefined {
    if (this.proxies.length === 0) return undefined;

    // Sticky: reuse the assigned proxy if still available.
    if (key) {
      const assigned = this.assignments.get(key);
      const existing = assigned ? this.proxies.find((p) => p.url === assigned) : undefined;
      if (existing && this.isAvailable(existing)) return this.use(existing);
    }

    let available = this.proxies.filter((p) => this.isAvailable(p));
    if (available.length === 0) return undefined; // all cooling down / retired → direct

    // Geo-coherence: prefer proxies whose timezone matches the identity's.
    if (preferTimezone) {
      const geo = available.filter((p) => p.timezoneId === preferTimezone);
      if (geo.length > 0) available = geo;
    }

    // Least-recently-used among the candidates.
    available.sort((a, b) => a.lastUsedAt - b.lastUsedAt);
    const chosen = available[0]!;
    if (key) this.assignments.set(key, chosen.url);
    return this.use(chosen);
  }

  private use(p: ProxyEntry): string {
    p.lastUsedAt = Date.now();
    return p.url;
  }

  /** Mark a proxy as blocked: cool it down, and retire it if burned too often. */
  reportBlocked(url: string): void {
    const p = this.proxies.find((x) => x.url === url);
    if (!p) return;
    p.blocks++;
    p.cooldownUntil = Date.now() + this.cooldownMs;
    if (p.blocks >= this.maxBlocks) p.retired = true;
  }

  /** A clean run — clear any cooldown (the IP looks healthy again). */
  reportSuccess(url: string): void {
    const p = this.proxies.find((x) => x.url === url);
    if (p) p.cooldownUntil = 0;
  }
}
