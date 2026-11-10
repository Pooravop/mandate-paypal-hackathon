import { z } from 'zod';
import { ledger } from '../ledger/ledger.ts';
import { id as newId } from '../util/ids.ts';
import { toMinor } from '../util/money.ts';
import { availableMinor } from '../policy/engine.ts';
import { CreateMandateInput, RevokeMandateInput, UpdateMandateInput, durationToMs } from './schemas.ts';
import type { Mandate } from '../types.ts';

export class DomainError extends Error {
  readonly statusCode: number;
  readonly code: string;
  constructor(code: string, message: string, statusCode = 400) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

/**
 * Expiry is evaluated at read time rather than by a background sweeper.
 *
 * A cron job that marks mandates expired is a liveness dependency: if it dies,
 * expired mandates keep authorising spend. Deriving it from the clock on every
 * read means an expired mandate is inert even if nothing else in the system is
 * running. The ledger still records the transition the first time we notice.
 */
export function effectiveStatus(m: Mandate, now = new Date()): Mandate['status'] {
  if (m.status === 'REVOKED') return 'REVOKED';
  const exp = new Date(m.expiresAt).getTime();
  if (Number.isFinite(exp) && exp <= now.getTime()) return 'EXPIRED';
  return m.status;
}

export function withEffectiveStatus(m: Mandate, now = new Date()): Mandate {
  const status = effectiveStatus(m, now);
  return status === m.status ? m : { ...m, status };
}

export function createMandate(raw: unknown): Mandate {
  const input = CreateMandateInput.parse(raw);
  const cur = input.currency;

  const budgetMinor = toMinor(input.budget, cur);
  const perTransactionCapMinor = toMinor(input.rules.perTransactionCap, cur);
  const autoApproveLimitMinor = toMinor(input.rules.autoApproveLimit, cur);
  const velocityMaxMinor = toMinor(input.rules.velocity.maxAmount, cur);

  if (budgetMinor <= 0) throw new DomainError('INVALID_BUDGET', 'Budget must be greater than zero');
  if (perTransactionCapMinor <= 0) throw new DomainError('INVALID_CAP', 'Per-transaction cap must be greater than zero');
  if (perTransactionCapMinor > budgetMinor) {
    throw new DomainError('CAP_EXCEEDS_BUDGET', 'The per-transaction cap cannot exceed the total budget');
  }
  if (autoApproveLimitMinor > perTransactionCapMinor) {
    throw new DomainError(
      'LIMIT_EXCEEDS_CAP',
      'The autonomous-approval limit cannot exceed the per-transaction cap, or it would never take effect',
    );
  }

  const now = new Date();
  const mandate: Mandate = {
    id: newId('mdt'),
    label: input.label,
    agentName: input.agentName,
    currency: cur,
    budgetMinor,
    reservedMinor: 0,
    spentMinor: 0,
    refundedMinor: 0,
    rules: {
      perTransactionCapMinor,
      autoApproveLimitMinor,
      velocity: {
        windowHours: input.rules.velocity.windowHours,
        maxTransactions: input.rules.velocity.maxTransactions,
        maxAmountMinor: velocityMaxMinor,
      },
      merchantAllowlist: input.rules.merchantAllowlist,
      merchantDenylist: input.rules.merchantDenylist,
      categoryAllowlist: input.rules.categoryAllowlist,
      categoryDenylist: input.rules.categoryDenylist,
      purpose: input.rules.purpose,
      requireHumanForAll: input.rules.requireHumanForAll,
    },
    status: 'ACTIVE',
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + durationToMs(input.expiresIn)).toISOString(),
  };

  ledger().append({
    type: 'MANDATE_CREATED',
    subject: mandate.id,
    actor: 'operator',
    summary: `Mandate "${mandate.label}" granted to ${mandate.agentName}`,
    data: { mandate },
  });

  return mandate;
}

export function getMandateOrThrow(id: string): Mandate {
  const m = ledger().getMandate(id);
  if (!m) throw new DomainError('MANDATE_NOT_FOUND', `No mandate with id ${id}`, 404);
  return withEffectiveStatus(m);
}

export function listMandates(): Array<Mandate & { availableMinor: number }> {
  return ledger()
    .listMandates()
    .map((m) => withEffectiveStatus(m))
    .map((m) => ({ ...m, availableMinor: availableMinor(m) }));
}

export function updateMandate(id: string, raw: unknown): Mandate {
  const input = UpdateMandateInput.parse(raw);
  const current = getMandateOrThrow(id);

  if (current.status !== 'ACTIVE') {
    throw new DomainError('MANDATE_NOT_ACTIVE', `Cannot modify a mandate that is ${current.status}`, 409);
  }

  const cur = current.currency;
  const next: Mandate = structuredClone(current);
  if (input.label) next.label = input.label;

  if (input.budget !== undefined) {
    const budgetMinor = toMinor(input.budget, cur);
    const committed = current.spentMinor + current.reservedMinor;
    if (budgetMinor < committed) {
      throw new DomainError(
        'BUDGET_BELOW_COMMITTED',
        `Cannot reduce the budget below the ${committed} minor units already spent or reserved`,
      );
    }
    next.budgetMinor = budgetMinor;
  }

  if (input.rules) {
    const r = input.rules;
    if (r.perTransactionCap !== undefined) next.rules.perTransactionCapMinor = toMinor(r.perTransactionCap, cur);
    if (r.autoApproveLimit !== undefined) next.rules.autoApproveLimitMinor = toMinor(r.autoApproveLimit, cur);
    if (r.velocity) {
      if (r.velocity.windowHours !== undefined) next.rules.velocity.windowHours = r.velocity.windowHours;
      if (r.velocity.maxTransactions !== undefined) next.rules.velocity.maxTransactions = r.velocity.maxTransactions;
      if (r.velocity.maxAmount !== undefined) next.rules.velocity.maxAmountMinor = toMinor(r.velocity.maxAmount, cur);
    }
    if (r.merchantAllowlist) next.rules.merchantAllowlist = r.merchantAllowlist;
    if (r.merchantDenylist) next.rules.merchantDenylist = r.merchantDenylist;
    if (r.categoryAllowlist) next.rules.categoryAllowlist = r.categoryAllowlist;
    if (r.categoryDenylist) next.rules.categoryDenylist = r.categoryDenylist;
    if (r.purpose) next.rules.purpose = r.purpose;
    if (r.requireHumanForAll !== undefined) next.rules.requireHumanForAll = r.requireHumanForAll;
  }

  if (next.rules.autoApproveLimitMinor > next.rules.perTransactionCapMinor) {
    throw new DomainError('LIMIT_EXCEEDS_CAP', 'The autonomous-approval limit cannot exceed the per-transaction cap');
  }

  ledger().append({
    type: 'MANDATE_UPDATED',
    subject: next.id,
    actor: 'operator',
    summary: `Mandate "${next.label}" updated`,
    data: { mandate: next },
  });

  return next;
}

/**
 * Revocation is immediate and unconditional -- the kill switch.
 * Already-settled payments cannot be undone (that is what refunds are for),
 * but no further spend can be authorised under this mandate from this moment.
 */
export function revokeMandate(id: string, raw: unknown): Mandate {
  const input = RevokeMandateInput.parse(raw);
  const current = getMandateOrThrow(id);
  if (current.status === 'REVOKED') return current;

  const patch = {
    status: 'REVOKED' as const,
    revokedAt: new Date().toISOString(),
    revokedReason: input.reason,
  };

  ledger().append({
    type: 'MANDATE_REVOKED',
    subject: id,
    actor: 'operator',
    summary: `Mandate "${current.label}" revoked: ${input.reason}`,
    data: { mandateId: id, mandatePatch: patch, reason: input.reason },
  });

  return { ...current, ...patch };
}

export function formatZodError(err: z.ZodError): string {
  return err.issues
    .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('; ');
}
