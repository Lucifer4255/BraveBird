import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type Fingerprint,
  FingerprintFactory,
  type FingerprintRecord,
  fingerprintFromRecord,
} from "./fingerprint.js";

/**
 * Identity = a durable persona: a fingerprint + its own session + a health record.
 *
 * "Design identities, don't just rotate fingerprints." Identities persist across
 * runs (so they accumulate history like a real returning user), carry a daily
 * quota and health metrics, and are RETIRED when they get burned (too many
 * blocks, or a high CAPTCHA rate) rather than reused.
 */

export interface IdentityHealth {
  successes: number;
  captchas: number;
  blocks: number;
  requestsToday: number;
  dayStamp: string; // YYYY-MM-DD — daily quota resets when this rolls over
  lastUsedAt: number;
  retired: boolean;
}

export interface Identity {
  id: string;
  fingerprint: Fingerprint;
  /** This persona's own session (cookies/storage) file. */
  sessionPath: string;
  health: IdentityHealth;
}

interface IdentityRecord {
  id: string;
  fingerprint: FingerprintRecord;
  health: IdentityHealth;
}

export interface IdentityPoolOptions {
  size?: number;
  dailyQuota?: number; // cap uses/day per identity (~500 in real systems)
  maxBlocks?: number; // retire after this many hard blocks
  captchaRetireRate?: number; // retire if captchas/uses exceeds this (min 6 uses)
  dir?: string; // where identities + sessions persist
  useGenerated?: boolean;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function freshHealth(): IdentityHealth {
  return {
    successes: 0,
    captchas: 0,
    blocks: 0,
    requestsToday: 0,
    dayStamp: today(),
    lastUsedAt: 0,
    retired: false,
  };
}

export class IdentityPool {
  private readonly identities: Identity[] = [];
  private readonly assignments = new Map<string, string>(); // sticky key → identity id
  private readonly dir: string;
  private readonly stateFile: string;
  private readonly size: number;
  private readonly dailyQuota: number;
  private readonly maxBlocks: number;
  private readonly captchaRetireRate: number;
  readonly mode: "generated" | "curated";

  constructor(opts: IdentityPoolOptions = {}) {
    this.size = opts.size ?? 8;
    this.dailyQuota = opts.dailyQuota ?? 500;
    this.maxBlocks = opts.maxBlocks ?? 3;
    this.captchaRetireRate = opts.captchaRetireRate ?? 0.5;
    this.dir = opts.dir ?? "sessions";
    this.stateFile = join(this.dir, "identities.json");
    mkdirSync(this.dir, { recursive: true });

    const factory = new FingerprintFactory(opts.useGenerated ?? true);
    this.mode = factory.mode;
    this.loadOrCreate(factory);
  }

  // ── persistence ──────────────────────────────────────────────────────────

  private loadOrCreate(factory: FingerprintFactory): void {
    if (existsSync(this.stateFile)) {
      try {
        const records: IdentityRecord[] = JSON.parse(readFileSync(this.stateFile, "utf8"));
        for (const r of records) {
          this.identities.push({
            id: r.id,
            fingerprint: fingerprintFromRecord(r.fingerprint),
            sessionPath: join(this.dir, `identity-${r.id}.json`),
            health: r.health,
          });
        }
      } catch {
        /* corrupt state — fall through and regenerate */
      }
    }
    while (this.identities.length < this.size) {
      const id = randomUUID().slice(0, 8);
      this.identities.push({
        id,
        fingerprint: factory.create(),
        sessionPath: join(this.dir, `identity-${id}.json`),
        health: freshHealth(),
      });
    }
    this.save();
  }

  private save(): void {
    const records: IdentityRecord[] = this.identities.map((i) => ({
      id: i.id,
      fingerprint: i.fingerprint.toJSON(),
      health: i.health,
    }));
    writeFileSync(this.stateFile, JSON.stringify(records, null, 2));
  }

  // ── selection ────────────────────────────────────────────────────────────

  /** Available = not retired and under today's quota (day resets automatically). */
  private isAvailable(i: Identity): boolean {
    if (i.health.retired) return false;
    if (i.health.dayStamp !== today()) {
      i.health.dayStamp = today();
      i.health.requestsToday = 0;
    }
    return i.health.requestsToday < this.dailyQuota;
  }

  /**
   * Acquire an identity. With a key, the same key sticks to the same identity
   * (a session shouldn't change fingerprint mid-flight) until it's burned/quota'd.
   */
  acquire(key?: string): Identity {
    if (key) {
      const assigned = this.assignments.get(key);
      const existing = assigned ? this.identities.find((i) => i.id === assigned) : undefined;
      if (existing && this.isAvailable(existing)) return this.use(existing);
    }
    // least-recently-used among available → spreads load, mimics real cadence
    const available = this.identities
      .filter((i) => this.isAvailable(i))
      .sort((a, b) => a.health.lastUsedAt - b.health.lastUsedAt);
    const chosen = available[0];
    if (!chosen) {
      throw new Error("IdentityPool exhausted — all identities retired or over daily quota");
    }
    if (key) this.assignments.set(key, chosen.id);
    return this.use(chosen);
  }

  private use(i: Identity): Identity {
    i.health.requestsToday++;
    i.health.lastUsedAt = Date.now();
    this.save();
    return i;
  }

  // ── outcome recording (the early-warning health signal) ─────────────────

  recordSuccess(id: string): void {
    this.byId(id).health.successes++;
    this.save();
  }

  recordCaptcha(id: string): void {
    const i = this.byId(id);
    i.health.captchas++;
    this.maybeRetire(i);
    this.save();
  }

  recordBlock(id: string): void {
    const i = this.byId(id);
    i.health.blocks++;
    this.maybeRetire(i);
    this.save();
  }

  retire(id: string): void {
    this.byId(id).health.retired = true;
    this.save();
  }

  private maybeRetire(i: Identity): void {
    if (i.health.blocks >= this.maxBlocks) {
      i.health.retired = true;
      return;
    }
    const uses = i.health.successes + i.health.captchas + i.health.blocks;
    if (uses >= 6 && i.health.captchas / uses > this.captchaRetireRate) {
      i.health.retired = true;
    }
  }

  private byId(id: string): Identity {
    const found = this.identities.find((i) => i.id === id);
    if (!found) throw new Error(`unknown identity "${id}"`);
    return found;
  }

  get healthyCount(): number {
    return this.identities.filter((i) => this.isAvailable(i)).length;
  }

  get all(): readonly Identity[] {
    return this.identities;
  }
}
