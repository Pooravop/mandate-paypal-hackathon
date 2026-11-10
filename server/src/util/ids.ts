import { randomUUID, createHash } from 'node:crypto';

/** Prefixed, sortable-ish, human-scannable identifiers: mdt_3f9a..., spr_..., txn_... */
export function id(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
}

export function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * Deterministic idempotency key for a PayPal write.
 * PayPal stores PayPal-Request-Id for 30 days, so a retry of the same logical
 * operation must present the same key or we risk double-paying a merchant.
 */
export function idempotencyKey(scope: string, ...parts: (string | number)[]): string {
  return `${scope}-${sha256(parts.join('|')).slice(0, 32)}`;
}
