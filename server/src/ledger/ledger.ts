import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { config } from '../config.ts';
import { id as newId } from '../util/ids.ts';
import { computeHash, GENESIS_HASH } from './hash.ts';
import type { LedgerEvent, LedgerEventType, Mandate, SpendRequest } from '../types.ts';

export interface AccountingDelta {
  mandateId: string;
  reservedDelta?: number;
  spentDelta?: number;
  refundedDelta?: number;
}

export interface AppendInput {
  type: LedgerEventType;
  subject: string;
  actor: string;
  summary: string;
  data?: Record<string, unknown>;
}

export interface VerifyResult {
  valid: boolean;
  length: number;
  headHash: string;
  brokenAt?: { seq: number; reason: string };
}

/**
 * Event-sourced store for the control plane.
 *
 * Every state change is an immutable, hash-chained event appended to
 * data/events.jsonl. Mandates and spend requests are projections rebuilt by
 * replaying that log, so the audit trail is not a side-effect of the state --
 * it *is* the state.
 *
 * That design choice is the point of the product: when an autonomous agent
 * spends real money, you need to prove after the fact exactly what it was
 * permitted to do and why each individual payment was allowed through. A
 * mutable row in a table cannot prove that; a hash chain can.
 */
export class Ledger extends EventEmitter {
  private events: LedgerEvent[] = [];
  private mandates = new Map<string, Mandate>();
  private requests = new Map<string, SpendRequest>();
  private readonly file: string;

  private readonly lockFile: string;

  constructor(dataDir = config.dataDir) {
    super();
    this.setMaxListeners(0);
    fs.mkdirSync(dataDir, { recursive: true });
    this.file = path.join(dataDir, 'events.jsonl');
    this.lockFile = path.join(dataDir, '.ledger.lock');
    this.acquireLock();
    this.load();
  }

  /**
   * A hash chain has exactly one valid writer.
   *
   * Two processes with the same log open each keep their own in-memory tail,
   * so their appends interleave into two divergent chains and verification
   * fails from the first crossover. That is very easy to do by accident --
   * `npm run dev` in one terminal and `npm run demo` in another -- and the
   * resulting corruption looks alarming while being entirely self-inflicted.
   *
   * So the writer takes an advisory lock. A lock held by this same process is
   * fine (tests reopen the log deliberately); a lock held by another live
   * process is refused with an explanation rather than silently tolerated.
   */
  private acquireLock(): void {
    if (['1', 'true', 'yes'].includes((process.env.LEDGER_ALLOW_MULTI_WRITER ?? '').toLowerCase())) return;

    const claim = () => {
      const fd = fs.openSync(this.lockFile, 'wx');
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
      fs.closeSync(fd);
      // Best-effort release. A hard kill leaves the file behind, which the
      // staleness check below then clears.
      process.once('exit', () => this.releaseLock());
    };

    try {
      claim();
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }

    let holder: { pid?: number } = {};
    try {
      holder = JSON.parse(fs.readFileSync(this.lockFile, 'utf8')) as { pid?: number };
    } catch {
      /* an unreadable lock is treated as stale */
    }

    if (holder.pid === process.pid) return;

    if (typeof holder.pid === 'number' && this.pidIsAlive(holder.pid)) {
      throw new Error(
        `The audit ledger at ${this.file} is already open for writing by process ${holder.pid}.\n` +
          `A hash-chained log can only have one writer: two processes appending to it would produce a corrupt chain.\n` +
          `Stop the other process, or point this one at its own directory with DATA_DIR=/some/other/path.\n` +
          `If you are certain the other process is gone, delete ${this.lockFile}.`,
      );
    }

    // Stale lock from a process that is no longer running.
    fs.rmSync(this.lockFile, { force: true });
    claim();
  }

  private pidIsAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      // EPERM means it exists but belongs to another user: still alive.
      return (err as NodeJS.ErrnoException).code === 'EPERM';
    }
  }

  private releaseLock(): void {
    try {
      const holder = JSON.parse(fs.readFileSync(this.lockFile, 'utf8')) as { pid?: number };
      if (holder.pid === process.pid) fs.rmSync(this.lockFile, { force: true });
    } catch {
      /* nothing to release */
    }
  }

  get filePath(): string {
    return this.file;
  }

  private load(): void {
    if (!fs.existsSync(this.file)) {
      this.append({
        type: 'LEDGER_INITIALISED',
        subject: 'ledger',
        actor: 'system',
        summary: 'Audit ledger created',
        data: { version: 1 },
      });
      return;
    }
    const lines = fs.readFileSync(this.file, 'utf8').split('\n').filter((l) => l.trim().length > 0);
    for (let i = 0; i < lines.length; i++) {
      try {
        const event = JSON.parse(lines[i] as string) as LedgerEvent;
        this.events.push(event);
        this.apply(event);
      } catch (err) {
        throw new Error(`Corrupt ledger at ${this.file} line ${i + 1}: ${(err as Error).message}`);
      }
    }
  }

  /** Append an event, extending the hash chain. Returns the stored event. */
  append(input: AppendInput): LedgerEvent {
    const prev = this.events.at(-1);
    const draft: Omit<LedgerEvent, 'hash'> = {
      seq: (prev?.seq ?? 0) + 1,
      id: newId('evt'),
      type: input.type,
      at: new Date().toISOString(),
      subject: input.subject,
      actor: input.actor,
      summary: input.summary,
      data: input.data ?? {},
      prevHash: prev?.hash ?? GENESIS_HASH,
    };
    const event: LedgerEvent = { ...draft, hash: computeHash(draft) };

    // Durability before visibility: if the disk write throws, we must not have
    // applied the event to the in-memory projection.
    fs.appendFileSync(this.file, JSON.stringify(event) + '\n', 'utf8');
    this.events.push(event);
    this.apply(event);
    this.emit('event', event);
    return event;
  }

  /**
   * Reducer. Deliberately dumb: every business decision is made before the
   * append, so a replay can never diverge from the original run.
   */
  private apply(event: LedgerEvent): void {
    const d = event.data as Record<string, any>;

    if (d.mandate) this.mandates.set(d.mandate.id, structuredClone(d.mandate) as Mandate);
    if (d.request) this.requests.set(d.request.id, structuredClone(d.request) as SpendRequest);

    if (d.requestPatch && typeof d.requestId === 'string') {
      const existing = this.requests.get(d.requestId);
      if (existing) {
        this.requests.set(d.requestId, {
          ...existing,
          ...(structuredClone(d.requestPatch) as Partial<SpendRequest>),
          updatedAt: event.at,
        });
      }
    }

    if (d.mandatePatch && typeof d.mandateId === 'string') {
      const existing = this.mandates.get(d.mandateId);
      if (existing) {
        this.mandates.set(d.mandateId, { ...existing, ...(structuredClone(d.mandatePatch) as Partial<Mandate>) });
      }
    }

    const acc = d.accounting as AccountingDelta | undefined;
    if (acc && acc.mandateId) {
      const m = this.mandates.get(acc.mandateId);
      if (m) {
        m.reservedMinor += acc.reservedDelta ?? 0;
        m.spentMinor += acc.spentDelta ?? 0;
        m.refundedMinor += acc.refundedDelta ?? 0;
        // Clamp rather than persist nonsense if a delta is ever malformed.
        if (m.reservedMinor < 0) m.reservedMinor = 0;
      }
    }
  }

  /** Recompute the entire chain and report the first point of divergence. */
  verify(): VerifyResult {
    let prevHash = GENESIS_HASH;
    for (let i = 0; i < this.events.length; i++) {
      const event = this.events[i] as LedgerEvent;
      if (event.seq !== i + 1) {
        return {
          valid: false,
          length: this.events.length,
          headHash: prevHash,
          brokenAt: { seq: event.seq, reason: `Sequence gap: expected ${i + 1}, found ${event.seq}` },
        };
      }
      if (event.prevHash !== prevHash) {
        return {
          valid: false,
          length: this.events.length,
          headHash: prevHash,
          brokenAt: { seq: event.seq, reason: 'Previous-hash link does not match the preceding event' },
        };
      }
      const { hash, ...rest } = event;
      if (computeHash(rest) !== hash) {
        return {
          valid: false,
          length: this.events.length,
          headHash: prevHash,
          brokenAt: { seq: event.seq, reason: 'Event body does not match its recorded hash (content was altered)' },
        };
      }
      prevHash = hash;
    }
    return { valid: true, length: this.events.length, headHash: prevHash };
  }

  list(opts: { limit?: number; subject?: string; type?: LedgerEventType } = {}): LedgerEvent[] {
    let out = this.events;
    if (opts.subject) out = out.filter((e) => e.subject === opts.subject);
    if (opts.type) out = out.filter((e) => e.type === opts.type);
    return out.slice(-(opts.limit ?? 200)).reverse();
  }

  head(): LedgerEvent | undefined {
    return this.events.at(-1);
  }

  size(): number {
    return this.events.length;
  }

  getMandate(id: string): Mandate | undefined {
    const m = this.mandates.get(id);
    return m ? structuredClone(m) : undefined;
  }

  listMandates(): Mandate[] {
    return [...this.mandates.values()]
      .map((m) => structuredClone(m))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  getRequest(id: string): SpendRequest | undefined {
    const r = this.requests.get(id);
    return r ? structuredClone(r) : undefined;
  }

  listRequests(opts: { mandateId?: string; status?: SpendRequest['status']; limit?: number } = {}): SpendRequest[] {
    let out = [...this.requests.values()];
    if (opts.mandateId) out = out.filter((r) => r.mandateId === opts.mandateId);
    if (opts.status) out = out.filter((r) => r.status === opts.status);
    out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return out.slice(0, opts.limit ?? 200).map((r) => structuredClone(r));
  }

  /**
   * Requests inside a rolling window that count against velocity limits.
   * Denied and failed attempts deliberately do not count -- a blocked request
   * must not be able to exhaust the agent's own velocity budget.
   */
  requestsSince(mandateId: string, sinceIso: string): SpendRequest[] {
    const counts: SpendRequest['status'][] = ['APPROVED', 'SETTLED', 'AWAITING_BUYER_APPROVAL', 'REFUNDED', 'PENDING_HUMAN'];
    return [...this.requests.values()].filter(
      (r) => r.mandateId === mandateId && r.createdAt >= sinceIso && counts.includes(r.status),
    );
  }

  /** Destroys the log and starts a fresh chain. Guarded by ALLOW_LEDGER_RESET. */
  reset(): void {
    fs.rmSync(this.file, { force: true });
    this.events = [];
    this.mandates.clear();
    this.requests.clear();
    this.load();
    this.emit('reset');
  }
}

let singleton: Ledger | undefined;

export function ledger(): Ledger {
  if (!singleton) singleton = new Ledger();
  return singleton;
}
