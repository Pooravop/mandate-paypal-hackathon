import { sha256 } from '../util/ids.ts';
import type { LedgerEvent } from '../types.ts';

export const GENESIS_HASH = '0'.repeat(64);

/**
 * Deterministic JSON serialisation: object keys sorted recursively.
 *
 * JSON.stringify preserves insertion order, which means two structurally
 * identical events could hash differently depending on how they were built.
 * For a tamper-evident chain that has to survive a full replay, the canonical
 * form must be stable.
 */
export function canonicalise(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return '[' + value.map(canonicalise).join(',') + ']';
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return '{' + entries.map(([k, v]) => JSON.stringify(k) + ':' + canonicalise(v)).join(',') + '}';
}

/** The exact payload that gets hashed. The `hash` field itself is excluded. */
export function hashPayload(e: Omit<LedgerEvent, 'hash'>): string {
  return canonicalise({
    seq: e.seq,
    id: e.id,
    type: e.type,
    at: e.at,
    subject: e.subject,
    actor: e.actor,
    summary: e.summary,
    data: e.data,
    prevHash: e.prevHash,
  });
}

export function computeHash(e: Omit<LedgerEvent, 'hash'>): string {
  return sha256(hashPayload(e));
}
