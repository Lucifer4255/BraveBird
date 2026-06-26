import { existsSync } from "node:fs";
import { type Browser, type BrowserContext, chromium } from "playwright";
import { config } from "../config.js";
import { type Identity, IdentityPool } from "../evasion/identity.js";
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
  private readonly contextIdentity = new Map<BrowserContext, Identity>();

  constructor(identityPool: IdentityPool = new IdentityPool()) {
    this.identities = identityPool;
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

    const context = await identity.fingerprint.createContext(this.browser, {
      storageState,
      proxyUrl: opts.proxyUrl,
    });

    this.contexts.add(context);
    this.contextIdentity.set(context, identity);
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

  // Outcome recording → feeds identity health / auto-retire.
  recordSuccess(context: BrowserContext): void {
    const id = this.contextIdentity.get(context);
    if (id) this.identities.recordSuccess(id.id);
  }
  recordCaptcha(context: BrowserContext): void {
    const id = this.contextIdentity.get(context);
    if (id) this.identities.recordCaptcha(id.id);
  }
  recordBlock(context: BrowserContext): void {
    const id = this.contextIdentity.get(context);
    if (id) this.identities.recordBlock(id.id);
  }
  /** Retire the identity that drove this context — it's burned. */
  banIdentity(context: BrowserContext): void {
    const id = this.contextIdentity.get(context);
    if (id) this.identities.retire(id.id);
  }

  identityFor(context: BrowserContext): Identity | undefined {
    return this.contextIdentity.get(context);
  }

  async releaseContext(context: BrowserContext): Promise<void> {
    this.contexts.delete(context);
    this.contextIdentity.delete(context);
    await context.close().catch(() => {});
  }

  async stop(): Promise<void> {
    for (const context of this.contexts) {
      await context.close().catch(() => {});
    }
    this.contexts.clear();
    this.contextIdentity.clear();
    await this.browser?.close().catch(() => {});
    this.browser = undefined;
  }

  get openContextCount(): number {
    return this.contexts.size;
  }

  get healthyIdentityCount(): number {
    return this.identities.healthyCount;
  }
}
