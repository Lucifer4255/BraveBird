import { existsSync } from "node:fs";
import { type Browser, type BrowserContext, chromium } from "playwright";
import { config } from "../config.js";
import { type Identity, IdentityPool } from "../evasion/identity.js";
import { ProxyPool } from "../evasion/proxyPool.js";
import { STEALTH_LAUNCH_ARGS } from "./stealth.js";

export interface AcquireOptions {
  /** Override the identity's own saved session with a specific storageState path. */
  storageState?: string;
  /** Sticky-identity key — same key reuses the same persona across runs. */
  sessionKey?: string;
  /** Proxy URL for this context (from the proxy pool at scale). */
  proxyUrl?: string;
}

/**
 * Owns ONE Chromium process and hands out isolated contexts, each driven by a
 * durable rotated IDENTITY (coherent fingerprint + its own persisted session +
 * health). Records outcomes so burned identities get retired.
 *
 *   const bm = new BrowserManager();
 *   await bm.start();
 *   const ctx = await bm.acquireContext({ sessionKey: job.id });
 *   try { ...; bm.recordSuccess(ctx); } catch { bm.recordBlock(ctx); }
 *   finally { await bm.persistSession(ctx); await bm.releaseContext(ctx); }
 *   await bm.stop();
 */
export class BrowserManager {
  private browser?: Browser;
  private readonly contexts = new Set<BrowserContext>();
  private readonly identities: IdentityPool;
  private readonly proxies: ProxyPool;
  private readonly contextIdentity = new Map<BrowserContext, Identity>();
  private readonly contextProxy = new Map<BrowserContext, string>();

  constructor(identityPool: IdentityPool = new IdentityPool(), proxyPool: ProxyPool = new ProxyPool()) {
    this.identities = identityPool;
    this.proxies = proxyPool;
  }

  async start(): Promise<void> {
    if (this.browser) return;
    this.browser = await chromium.launch({
      headless: config.browser.headless,
      args: STEALTH_LAUNCH_ARGS,
    });
  }

  /**
   * Create a fresh isolated context for one job, driven by a rotated identity.
   * The identity's own persisted session is loaded automatically (so the persona
   * accumulates history), unless a specific storageState is passed.
   */
  async acquireContext(opts: AcquireOptions = {}): Promise<BrowserContext> {
    if (!this.browser) {
      throw new Error("BrowserManager.start() must be called before acquireContext()");
    }

    const identity = this.identities.acquire(opts.sessionKey);
    const storageState =
      opts.storageState ?? (existsSync(identity.sessionPath) ? identity.sessionPath : undefined);

    // Pair the identity with a geo-coherent proxy (sticky per session key).
    // Empty pool → undefined → run direct.
    const proxyUrl =
      opts.proxyUrl ?? this.proxies.acquire(opts.sessionKey, identity.fingerprint.timezoneId);

    const context = await identity.fingerprint.createContext(this.browser, {
      storageState,
      proxyUrl,
    });

    // Record a trace from the start; telemetry SAVES it on failure, else it's
    // discarded on release. (Captures screenshots + DOM snapshots for replay.)
    if (config.telemetry.enabled) {
      await context.tracing.start({ screenshots: true, snapshots: true }).catch(() => {});
    }

    this.contexts.add(context);
    this.contextIdentity.set(context, identity);
    if (proxyUrl) this.contextProxy.set(context, proxyUrl);
    return context;
  }

  /** Save the context's session back onto its identity (persona continuity). */
  async persistSession(context: BrowserContext): Promise<void> {
    const identity = this.contextIdentity.get(context);
    if (!identity) return;
    await context
      .storageState({ path: identity.sessionPath, indexedDB: true })
      .catch(() => {});
  }

  // Outcome recording → feeds BOTH identity health and proxy health.
  recordSuccess(context: BrowserContext): void {
    const id = this.contextIdentity.get(context);
    if (id) this.identities.recordSuccess(id.id);
    const proxy = this.contextProxy.get(context);
    if (proxy) this.proxies.reportSuccess(proxy);
  }
  recordCaptcha(context: BrowserContext): void {
    const id = this.contextIdentity.get(context);
    if (id) this.identities.recordCaptcha(id.id);
    const proxy = this.contextProxy.get(context);
    if (proxy) this.proxies.reportBlocked(proxy); // a challenged IP needs a rest
  }
  recordBlock(context: BrowserContext): void {
    const id = this.contextIdentity.get(context);
    if (id) this.identities.recordBlock(id.id);
    const proxy = this.contextProxy.get(context);
    if (proxy) this.proxies.reportBlocked(proxy);
  }
  /** Retire the identity that drove this context — it's burned. */
  banIdentity(context: BrowserContext): void {
    const id = this.contextIdentity.get(context);
    if (id) this.identities.retire(id.id);
  }

  identityFor(context: BrowserContext): Identity | undefined {
    return this.contextIdentity.get(context);
  }

  proxyFor(context: BrowserContext): string | undefined {
    return this.contextProxy.get(context);
  }

  async releaseContext(context: BrowserContext): Promise<void> {
    this.contexts.delete(context);
    this.contextIdentity.delete(context);
    this.contextProxy.delete(context);
    // Discard the trace if it wasn't already saved by telemetry on failure
    // (double-stop just throws and is ignored).
    await context.tracing.stop().catch(() => {});
    await context.close().catch(() => {});
  }

  async stop(): Promise<void> {
    for (const context of this.contexts) {
      await context.close().catch(() => {});
    }
    this.contexts.clear();
    this.contextIdentity.clear();
    this.contextProxy.clear();
    await this.browser?.close().catch(() => {});
    this.browser = undefined;
  }

  get openContextCount(): number {
    return this.contexts.size;
  }

  get healthyIdentityCount(): number {
    return this.identities.healthyCount;
  }

  get healthyProxyCount(): number {
    return this.proxies.healthyCount;
  }
}
