import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, combine, availableMinor } from '../src/policy/engine.ts';
import type { Mandate, Merchant, RuleResult } from '../src/types.ts';

function mandate(overrides: Partial<Mandate> = {}, ruleOverrides: Partial<Mandate['rules']> = {}): Mandate {
  return {
    id: 'mdt_test',
    label: 'Test mandate',
    agentName: 'test-agent',
    currency: 'USD',
    budgetMinor: 200000,
    reservedMinor: 0,
    spentMinor: 0,
    refundedMinor: 0,
    status: 'ACTIVE',
    createdAt: new Date(Date.now() - 1000).toISOString(),
    expiresAt: new Date(Date.now() + 30 * 86400000).toISOString(),
    rules: {
      perTransactionCapMinor: 60000,
      autoApproveLimitMinor: 25000,
      velocity: { windowHours: 24, maxTransactions: 8, maxAmountMinor: 120000 },
      merchantAllowlist: [],
      merchantDenylist: [],
      categoryAllowlist: [],
      categoryDenylist: ['gift-cards'],
      purpose: 'Keep the production data pipeline running: cloud compute and monitoring.',
      requireHumanForAll: false,
      ...ruleOverrides,
    },
    ...overrides,
  };
}

const merchant: Merchant = {
  id: 'northwind-cloud',
  name: 'Northwind Cloud',
  receiver: 'r@example.com',
  category: 'cloud-infrastructure',
  trustTier: 'VERIFIED',
  about: '',
};

function req(amountMinor: number, overrides: Record<string, unknown> = {}) {
  return {
    amountMinor,
    currency: 'USD',
    merchantId: 'northwind-cloud',
    category: 'cloud-infrastructure',
    description: 'Standard compute node',
    ...overrides,
  } as Parameters<typeof evaluate>[0]['request'];
}

function rule(rules: RuleResult[], code: string): RuleResult {
  const found = rules.find((r) => r.code === code);
  assert.ok(found, `expected a rule result for ${code}`);
  return found;
}

describe('policy: clean path', () => {
  test('approves an in-limit request with every rule passing', () => {
    const v = evaluate({ mandate: mandate(), request: req(8400), merchant, priorInWindow: [] });
    assert.equal(v.decision, 'APPROVE');
    assert.equal(v.terminal, false);
    assert.equal(v.forcesHuman, false);
    assert.equal(v.rules.every((r) => r.status === 'PASS'), true);
  });
});

describe('policy: hard limits are terminal', () => {
  test('blocks a request over the per-transaction cap', () => {
    const v = evaluate({ mandate: mandate(), request: req(74900), merchant, priorInWindow: [] });
    assert.equal(v.decision, 'DENY');
    assert.equal(v.terminal, true);
    assert.equal(rule(v.rules, 'PER_TX_CAP').status, 'FAIL');
  });

  test('blocks a request exceeding uncommitted budget, counting reservations', () => {
    // 200000 budget, 150000 spent, 40000 already reserved -> only 10000 free.
    const m = mandate({ spentMinor: 150000, reservedMinor: 40000 });
    assert.equal(availableMinor(m), 10000);
    const v = evaluate({ mandate: m, request: req(20000), merchant, priorInWindow: [] });
    assert.equal(v.decision, 'DENY');
    assert.equal(rule(v.rules, 'BUDGET_REMAINING').status, 'FAIL');
  });

  test('blocks a denylisted category', () => {
    const v = evaluate({
      mandate: mandate(),
      request: req(1000, { category: 'gift-cards', merchantId: 'moonlit-rewards' }),
      merchant: { ...merchant, id: 'moonlit-rewards', category: 'gift-cards' },
      priorInWindow: [],
    });
    assert.equal(v.decision, 'DENY');
    assert.equal(rule(v.rules, 'CATEGORY_DENYLIST').status, 'FAIL');
  });

  test('enforces a merchant allowlist when one is set', () => {
    const m = mandate({}, { merchantAllowlist: ['helio-observability'] });
    const v = evaluate({ mandate: m, request: req(1000), merchant, priorInWindow: [] });
    assert.equal(v.decision, 'DENY');
    assert.equal(rule(v.rules, 'MERCHANT_ALLOWLIST').status, 'FAIL');
  });

  test('an empty allowlist permits everything not denylisted', () => {
    const v = evaluate({ mandate: mandate(), request: req(1000), merchant, priorInWindow: [] });
    assert.equal(rule(v.rules, 'MERCHANT_ALLOWLIST').status, 'PASS');
  });

  test('a denylist overrides membership of the allowlist', () => {
    const m = mandate({}, { merchantAllowlist: ['northwind-cloud'], merchantDenylist: ['northwind-cloud'] });
    const v = evaluate({ mandate: m, request: req(1000), merchant, priorInWindow: [] });
    assert.equal(v.decision, 'DENY');
    assert.equal(rule(v.rules, 'MERCHANT_DENYLIST').status, 'FAIL');
  });

  test('blocks a revoked mandate', () => {
    const v = evaluate({ mandate: mandate({ status: 'REVOKED', revokedReason: 'kill switch' }), request: req(100), merchant, priorInWindow: [] });
    assert.equal(v.decision, 'DENY');
    assert.equal(rule(v.rules, 'MANDATE_ACTIVE').status, 'FAIL');
  });

  test('blocks an expired mandate even if its status still says ACTIVE', () => {
    const v = evaluate({
      mandate: mandate({ expiresAt: new Date(Date.now() - 1000).toISOString() }),
      request: req(100),
      merchant,
      priorInWindow: [],
    });
    assert.equal(v.decision, 'DENY');
    assert.equal(rule(v.rules, 'MANDATE_NOT_EXPIRED').status, 'FAIL');
  });

  test('blocks a currency mismatch', () => {
    const v = evaluate({ mandate: mandate(), request: req(100, { currency: 'EUR' }), merchant, priorInWindow: [] });
    assert.equal(v.decision, 'DENY');
    assert.equal(rule(v.rules, 'CURRENCY_MATCH').status, 'FAIL');
  });

  test('rejects non-positive amounts', () => {
    for (const bad of [0, -500]) {
      const v = evaluate({ mandate: mandate(), request: req(bad), merchant, priorInWindow: [] });
      assert.equal(v.decision, 'DENY', `amount ${bad} should be denied`);
      assert.equal(rule(v.rules, 'AMOUNT_VALID').status, 'FAIL');
    }
  });
});

describe('policy: velocity', () => {
  const inWindow = (n: number, amountMinor: number) =>
    Array.from({ length: n }, (_, i) => ({
      amountMinor,
      merchantId: 'helio-observability',
      createdAt: new Date(Date.now() - (i + 1) * 60000).toISOString(),
      description: `prior ${i}`,
    }));

  test('blocks when the transaction count would be exceeded', () => {
    const v = evaluate({ mandate: mandate(), request: req(100), merchant, priorInWindow: inWindow(8, 100) });
    assert.equal(v.decision, 'DENY');
    assert.equal(rule(v.rules, 'VELOCITY_COUNT').status, 'FAIL');
  });

  test('allows the final transaction inside the count limit', () => {
    const v = evaluate({ mandate: mandate(), request: req(100), merchant, priorInWindow: inWindow(7, 100) });
    assert.equal(rule(v.rules, 'VELOCITY_COUNT').status, 'PASS');
  });

  test('blocks when the rolling amount would be exceeded', () => {
    const v = evaluate({ mandate: mandate(), request: req(30000), merchant, priorInWindow: inWindow(5, 20000) });
    assert.equal(v.decision, 'DENY');
    assert.equal(rule(v.rules, 'VELOCITY_AMOUNT').status, 'FAIL');
  });

  test('ignores requests that fall outside the window', () => {
    const old = [{
      amountMinor: 100000,
      merchantId: 'helio-observability',
      createdAt: new Date(Date.now() - 48 * 3.6e6).toISOString(),
      description: 'two days ago',
    }];
    // Kept under the autonomous limit so the only thing under test is velocity.
    const v = evaluate({ mandate: mandate(), request: req(20000), merchant, priorInWindow: old });
    assert.equal(rule(v.rules, 'VELOCITY_AMOUNT').status, 'PASS');
    assert.equal(rule(v.rules, 'VELOCITY_COUNT').status, 'PASS');
    assert.equal(v.decision, 'APPROVE');
  });
});

describe('policy: soft signals', () => {
  test('flags an unverified merchant without blocking it', () => {
    const v = evaluate({
      mandate: mandate(),
      request: req(1000),
      merchant: { ...merchant, trustTier: 'UNVERIFIED' },
      priorInWindow: [],
    });
    assert.equal(rule(v.rules, 'MERCHANT_TRUST').status, 'FLAG');
    assert.equal(v.decision, 'ESCALATE');
    assert.equal(v.terminal, false);
    assert.equal(v.forcesHuman, false, 'an unverified merchant should still be clearable by the AI layer');
  });

  test('flags an identical recent charge as a probable duplicate', () => {
    const v = evaluate({
      mandate: mandate(),
      request: req(8400),
      merchant,
      priorInWindow: [{
        amountMinor: 8400,
        merchantId: 'northwind-cloud',
        createdAt: new Date(Date.now() - 60000).toISOString(),
        description: 'same thing a minute ago',
      }],
    });
    assert.equal(rule(v.rules, 'DUPLICATE_SUSPECTED').status, 'FLAG');
  });

  test('does not flag an identical charge once the duplicate window has passed', () => {
    const v = evaluate({
      mandate: mandate(),
      request: req(8400),
      merchant,
      priorInWindow: [{
        amountMinor: 8400,
        merchantId: 'northwind-cloud',
        createdAt: new Date(Date.now() - 40 * 60000).toISOString(),
        description: 'same thing 40 minutes ago',
      }],
    });
    assert.equal(rule(v.rules, 'DUPLICATE_SUSPECTED').status, 'PASS');
  });
});

describe('policy: human-approval ratchet', () => {
  test('forces a human at or above the autonomous limit', () => {
    const v = evaluate({ mandate: mandate(), request: req(25000), merchant, priorInWindow: [] });
    assert.equal(v.decision, 'ESCALATE');
    assert.equal(v.forcesHuman, true);
    assert.equal(rule(v.rules, 'AUTO_APPROVE_LIMIT').status, 'FLAG');
  });

  test('stays autonomous one cent below the limit', () => {
    const v = evaluate({ mandate: mandate(), request: req(24999), merchant, priorInWindow: [] });
    assert.equal(v.decision, 'APPROVE');
    assert.equal(v.forcesHuman, false);
  });

  test('requireHumanForAll forces a human at any amount', () => {
    const m = mandate({}, { requireHumanForAll: true });
    const v = evaluate({ mandate: m, request: req(1), merchant, priorInWindow: [] });
    assert.equal(v.forcesHuman, true);
    assert.equal(v.decision, 'ESCALATE');
  });
});

describe('policy: combine - the AI can only tighten', () => {
  const approved = evaluate({ mandate: mandate(), request: req(1000), merchant, priorInWindow: [] });
  const denied = evaluate({ mandate: mandate(), request: req(74900), merchant, priorInWindow: [] });
  const forced = evaluate({ mandate: mandate(), request: req(25000), merchant, priorInWindow: [] });

  test('an AI approval cannot overturn a deterministic denial', () => {
    assert.equal(combine(denied, { decision: 'APPROVE' }).decision, 'DENY');
  });

  test('an AI approval cannot clear a rule that forces a human', () => {
    const result = combine(forced, { decision: 'APPROVE' });
    assert.equal(result.decision, 'ESCALATE');
    assert.match(result.reason, /require explicit human approval/);
  });

  test('an AI denial overrides a clean policy pass', () => {
    assert.equal(combine(approved, { decision: 'DENY' }).decision, 'DENY');
  });

  test('an AI escalation overrides a clean policy pass', () => {
    assert.equal(combine(approved, { decision: 'ESCALATE' }).decision, 'ESCALATE');
  });

  test('both layers clean yields an approval', () => {
    assert.equal(combine(approved, { decision: 'APPROVE' }).decision, 'APPROVE');
  });

  test('a missing AI judgement does not auto-approve a flagged request', () => {
    // If adjudication never ran, a flagged request must not sail through.
    assert.equal(combine(forced, undefined).decision, 'ESCALATE');
    assert.equal(combine(denied, undefined).decision, 'DENY');
  });
});
