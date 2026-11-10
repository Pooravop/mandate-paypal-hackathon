import { format } from '../util/money.ts';
import type { Mandate, Merchant, PolicyVerdict, RuleResult, SpendRequest } from '../types.ts';

/**
 * The deterministic gate.
 *
 * Design principle: an LLM must never be the only thing standing between an
 * agent and your bank balance. Hard limits -- budget, caps, allowlists,
 * velocity, expiry -- are enforced by code that cannot be talked out of its
 * position by a persuasive argument in a prompt. The LLM runs *after* this,
 * and only ever to catch the class of problem rules cannot see: a purchase
 * that is technically within limits but has nothing to do with what the
 * mandate was granted for.
 *
 * Consequences of that ordering:
 *  - a FAIL here is terminal; the LLM is not consulted and cannot overturn it
 *  - the LLM can tighten the outcome (approve -> escalate/deny) but never loosen it
 *  - rules that force a human (`forcesHuman`) survive an enthusiastic LLM approval
 */

export interface EvaluationContext {
  mandate: Mandate;
  request: Pick<SpendRequest, 'amountMinor' | 'currency' | 'merchantId' | 'category' | 'description'>;
  merchant?: Merchant;
  /** Prior in-window requests, for velocity limits. */
  priorInWindow: Array<Pick<SpendRequest, 'amountMinor' | 'merchantId' | 'createdAt' | 'description'>>;
  now?: Date;
}

/** Rules whose FLAG cannot be cleared by the AI layer -- they always need a human. */
const FORCES_HUMAN = new Set(['AUTO_APPROVE_LIMIT', 'REQUIRE_HUMAN_ALL']);

/** Window for treating an identical merchant+amount pair as a probable double-charge. */
const DUPLICATE_WINDOW_MS = 10 * 60 * 1000;

export function availableMinor(m: Mandate): number {
  return m.budgetMinor - m.spentMinor - m.reservedMinor;
}

export function evaluate(ctx: EvaluationContext): PolicyVerdict {
  const now = ctx.now ?? new Date();
  const { mandate, request, merchant } = ctx;
  const cur = mandate.currency;
  const rules: RuleResult[] = [];

  const pass = (code: string, title: string, detail: string, evidence?: Record<string, unknown>) =>
    rules.push({ code, title, status: 'PASS', detail, evidence });
  const flag = (code: string, title: string, detail: string, evidence?: Record<string, unknown>) =>
    rules.push({ code, title, status: 'FLAG', detail, evidence });
  const fail = (code: string, title: string, detail: string, evidence?: Record<string, unknown>) =>
    rules.push({ code, title, status: 'FAIL', detail, evidence });

  // --- Mandate validity -------------------------------------------------
  if (mandate.status === 'REVOKED') {
    fail('MANDATE_ACTIVE', 'Mandate is active', `Mandate was revoked${mandate.revokedReason ? `: ${mandate.revokedReason}` : ''}`, {
      status: mandate.status,
      revokedAt: mandate.revokedAt,
    });
  } else if (mandate.status === 'EXPIRED') {
    fail('MANDATE_ACTIVE', 'Mandate is active', 'Mandate has expired', { status: mandate.status });
  } else {
    pass('MANDATE_ACTIVE', 'Mandate is active', 'Mandate is active and usable', { status: mandate.status });
  }

  const expiresAt = new Date(mandate.expiresAt);
  if (Number.isFinite(expiresAt.getTime()) && expiresAt.getTime() <= now.getTime()) {
    fail('MANDATE_NOT_EXPIRED', 'Within mandate validity window', `Mandate expired at ${mandate.expiresAt}`, {
      expiresAt: mandate.expiresAt,
      now: now.toISOString(),
    });
  } else {
    const hoursLeft = (expiresAt.getTime() - now.getTime()) / 3.6e6;
    pass('MANDATE_NOT_EXPIRED', 'Within mandate validity window', `Valid for another ${hoursLeft.toFixed(1)}h`, {
      expiresAt: mandate.expiresAt,
      hoursRemaining: Number(hoursLeft.toFixed(2)),
    });
  }

  // --- Amount sanity ----------------------------------------------------
  if (request.currency.toUpperCase() !== cur.toUpperCase()) {
    fail('CURRENCY_MATCH', 'Currency matches mandate', `Request is in ${request.currency} but the mandate is denominated in ${cur}`, {
      requestCurrency: request.currency,
      mandateCurrency: cur,
    });
  } else {
    pass('CURRENCY_MATCH', 'Currency matches mandate', `Both in ${cur}`, { currency: cur });
  }

  if (!Number.isSafeInteger(request.amountMinor) || request.amountMinor <= 0) {
    fail('AMOUNT_VALID', 'Amount is a positive value', `Rejecting non-positive or non-integer amount: ${request.amountMinor}`, {
      amountMinor: request.amountMinor,
    });
  } else {
    pass('AMOUNT_VALID', 'Amount is a positive value', format(request.amountMinor, cur), { amountMinor: request.amountMinor });
  }

  // --- Per-transaction cap ---------------------------------------------
  const cap = mandate.rules.perTransactionCapMinor;
  if (request.amountMinor > cap) {
    fail('PER_TX_CAP', 'Within per-transaction cap', `${format(request.amountMinor, cur)} exceeds the per-transaction cap of ${format(cap, cur)}`, {
      amountMinor: request.amountMinor,
      capMinor: cap,
      overByMinor: request.amountMinor - cap,
    });
  } else {
    pass('PER_TX_CAP', 'Within per-transaction cap', `${format(request.amountMinor, cur)} of ${format(cap, cur)} cap`, {
      amountMinor: request.amountMinor,
      capMinor: cap,
    });
  }

  // --- Remaining budget -------------------------------------------------
  const available = availableMinor(mandate);
  if (request.amountMinor > available) {
    fail('BUDGET_REMAINING', 'Sufficient uncommitted budget', `${format(request.amountMinor, cur)} exceeds the ${format(Math.max(0, available), cur)} still uncommitted on this mandate`, {
      amountMinor: request.amountMinor,
      availableMinor: available,
      budgetMinor: mandate.budgetMinor,
      spentMinor: mandate.spentMinor,
      reservedMinor: mandate.reservedMinor,
    });
  } else {
    pass('BUDGET_REMAINING', 'Sufficient uncommitted budget', `${format(available, cur)} available, ${format(available - request.amountMinor, cur)} would remain`, {
      availableMinor: available,
      afterMinor: available - request.amountMinor,
    });
  }

  // --- Merchant controls ------------------------------------------------
  const deny = mandate.rules.merchantDenylist ?? [];
  const allow = mandate.rules.merchantAllowlist ?? [];
  if (deny.includes(request.merchantId)) {
    fail('MERCHANT_DENYLIST', 'Merchant not denylisted', `${request.merchantId} is on the mandate denylist`, { merchantId: request.merchantId, denylist: deny });
  } else {
    pass('MERCHANT_DENYLIST', 'Merchant not denylisted', 'Merchant is not denylisted', { merchantId: request.merchantId });
  }

  if (allow.length > 0 && !allow.includes(request.merchantId)) {
    fail('MERCHANT_ALLOWLIST', 'Merchant is allowlisted', `${request.merchantId} is not on the mandate allowlist`, {
      merchantId: request.merchantId,
      allowlist: allow,
    });
  } else {
    pass('MERCHANT_ALLOWLIST', 'Merchant is allowlisted', allow.length === 0 ? 'No allowlist set, all non-denylisted merchants permitted' : 'Merchant is on the allowlist', {
      allowlistEnforced: allow.length > 0,
    });
  }

  // --- Category controls ------------------------------------------------
  const catDeny = mandate.rules.categoryDenylist ?? [];
  const catAllow = mandate.rules.categoryAllowlist ?? [];
  if (catDeny.includes(request.category)) {
    fail('CATEGORY_DENYLIST', 'Category not denylisted', `Category "${request.category}" is denylisted on this mandate`, {
      category: request.category,
      denylist: catDeny,
    });
  } else {
    pass('CATEGORY_DENYLIST', 'Category not denylisted', `Category "${request.category}" is permitted`, { category: request.category });
  }

  if (catAllow.length > 0 && !catAllow.includes(request.category)) {
    fail('CATEGORY_ALLOWLIST', 'Category is allowlisted', `Category "${request.category}" is outside the allowed set [${catAllow.join(', ')}]`, {
      category: request.category,
      allowlist: catAllow,
    });
  } else {
    pass('CATEGORY_ALLOWLIST', 'Category is allowlisted', catAllow.length === 0 ? 'No category allowlist set' : `"${request.category}" is allowed`, {
      allowlistEnforced: catAllow.length > 0,
    });
  }

  // --- Velocity ---------------------------------------------------------
  const vel = mandate.rules.velocity;
  const windowMs = vel.windowHours * 3.6e6;
  const windowStart = new Date(now.getTime() - windowMs).toISOString();
  const inWindow = ctx.priorInWindow.filter((r) => r.createdAt >= windowStart);
  const windowSum = inWindow.reduce((s, r) => s + r.amountMinor, 0);

  if (inWindow.length + 1 > vel.maxTransactions) {
    fail('VELOCITY_COUNT', 'Within transaction velocity limit', `This would be transaction ${inWindow.length + 1} in ${vel.windowHours}h, over the limit of ${vel.maxTransactions}`, {
      inWindow: inWindow.length,
      maxTransactions: vel.maxTransactions,
      windowHours: vel.windowHours,
    });
  } else {
    pass('VELOCITY_COUNT', 'Within transaction velocity limit', `${inWindow.length + 1} of ${vel.maxTransactions} transactions in the ${vel.windowHours}h window`, {
      inWindow: inWindow.length,
      maxTransactions: vel.maxTransactions,
    });
  }

  if (windowSum + request.amountMinor > vel.maxAmountMinor) {
    fail('VELOCITY_AMOUNT', 'Within spend velocity limit', `${format(windowSum + request.amountMinor, cur)} in ${vel.windowHours}h would exceed the ${format(vel.maxAmountMinor, cur)} rolling limit`, {
      windowSumMinor: windowSum,
      amountMinor: request.amountMinor,
      maxAmountMinor: vel.maxAmountMinor,
    });
  } else {
    pass('VELOCITY_AMOUNT', 'Within spend velocity limit', `${format(windowSum + request.amountMinor, cur)} of ${format(vel.maxAmountMinor, cur)} in the ${vel.windowHours}h window`, {
      windowSumMinor: windowSum,
      maxAmountMinor: vel.maxAmountMinor,
    });
  }

  // --- Soft signals (FLAG: needs scrutiny, not a hard block) ------------
  if (merchant && merchant.trustTier === 'UNVERIFIED') {
    flag('MERCHANT_TRUST', 'Merchant is verified', `${merchant.name} is an unverified merchant`, { merchantId: merchant.id, trustTier: merchant.trustTier });
  } else {
    pass('MERCHANT_TRUST', 'Merchant is verified', merchant ? `${merchant.name} is ${merchant.trustTier.toLowerCase()}` : 'Merchant trust tier unknown', {
      trustTier: merchant?.trustTier ?? 'UNKNOWN',
    });
  }

  const duplicate = ctx.priorInWindow.find(
    (r) =>
      r.merchantId === request.merchantId &&
      r.amountMinor === request.amountMinor &&
      now.getTime() - new Date(r.createdAt).getTime() < DUPLICATE_WINDOW_MS,
  );
  if (duplicate) {
    flag('DUPLICATE_SUSPECTED', 'Not an apparent duplicate', `An identical ${format(request.amountMinor, cur)} charge to ${request.merchantId} was requested at ${duplicate.createdAt}`, {
      priorAt: duplicate.createdAt,
      windowMinutes: DUPLICATE_WINDOW_MS / 60000,
    });
  } else {
    pass('DUPLICATE_SUSPECTED', 'Not an apparent duplicate', 'No matching recent charge', {});
  }

  // --- Human-approval thresholds ---------------------------------------
  if (mandate.rules.requireHumanForAll) {
    flag('REQUIRE_HUMAN_ALL', 'Human approval not required', 'This mandate requires human approval for every spend', { requireHumanForAll: true });
  } else {
    pass('REQUIRE_HUMAN_ALL', 'Human approval not required', 'Mandate permits autonomous settlement', { requireHumanForAll: false });
  }

  const autoLimit = mandate.rules.autoApproveLimitMinor;
  if (request.amountMinor >= autoLimit) {
    flag('AUTO_APPROVE_LIMIT', 'Below autonomous-approval threshold', `${format(request.amountMinor, cur)} is at or above the ${format(autoLimit, cur)} autonomous limit, so a human must approve`, {
      amountMinor: request.amountMinor,
      autoApproveLimitMinor: autoLimit,
    });
  } else {
    pass('AUTO_APPROVE_LIMIT', 'Below autonomous-approval threshold', `${format(request.amountMinor, cur)} is under the ${format(autoLimit, cur)} autonomous limit`, {
      amountMinor: request.amountMinor,
      autoApproveLimitMinor: autoLimit,
    });
  }

  // --- Verdict ----------------------------------------------------------
  const failures = rules.filter((r) => r.status === 'FAIL');
  const flags = rules.filter((r) => r.status === 'FLAG');
  const forcesHuman = flags.some((r) => FORCES_HUMAN.has(r.code));

  if (failures.length > 0) {
    return {
      decision: 'DENY',
      rules,
      reason: `Blocked by ${failures.length} hard rule${failures.length === 1 ? '' : 's'}: ${failures.map((f) => f.code).join(', ')}`,
      terminal: true,
      forcesHuman: false,
    };
  }

  if (flags.length > 0) {
    return {
      decision: 'ESCALATE',
      rules,
      reason: `All hard limits satisfied, but ${flags.length} signal${flags.length === 1 ? ' needs' : 's need'} review: ${flags.map((f) => f.code).join(', ')}`,
      terminal: false,
      forcesHuman,
    };
  }

  return {
    decision: 'APPROVE',
    rules,
    reason: 'All deterministic limits satisfied',
    terminal: false,
    forcesHuman: false,
  };
}

/**
 * Fold the deterministic verdict and the AI judgement into one outcome.
 * The AI can only ever make the result stricter.
 */
export function combine(policy: PolicyVerdict, ai?: { decision: 'APPROVE' | 'ESCALATE' | 'DENY' }): {
  decision: 'APPROVE' | 'ESCALATE' | 'DENY';
  reason: string;
} {
  if (policy.decision === 'DENY') return { decision: 'DENY', reason: policy.reason };
  if (ai?.decision === 'DENY') return { decision: 'DENY', reason: 'Denied by AI intent adjudication' };
  if (policy.forcesHuman) {
    return { decision: 'ESCALATE', reason: 'Mandate rules require explicit human approval for this spend' };
  }
  if (ai?.decision === 'ESCALATE') return { decision: 'ESCALATE', reason: 'AI adjudication requested human review' };
  if (policy.decision === 'ESCALATE') return { decision: 'ESCALATE', reason: policy.reason };
  return { decision: 'APPROVE', reason: 'Cleared deterministic rules and AI intent adjudication' };
}
