import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * End-to-end pipeline tests.
 *
 * These run against the local PayPal simulator and the built-in reasoner, so
 * they are hermetic: no credentials, no network, deterministic outcomes. The
 * modules are imported dynamically *after* DATA_DIR is set, because config.ts
 * snapshots the environment at module-evaluation time.
 */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mandate-pipeline-'));

let createMandate: typeof import('../src/service/mandates.ts')['createMandate'];
let getMandateOrThrow: typeof import('../src/service/mandates.ts')['getMandateOrThrow'];
let revokeMandate: typeof import('../src/service/mandates.ts')['revokeMandate'];
let requestSpend: typeof import('../src/service/spend.ts')['requestSpend'];
let decideHuman: typeof import('../src/service/spend.ts')['decideHuman'];
let completeBuyerApproval: typeof import('../src/service/spend.ts')['completeBuyerApproval'];
let refundRequest: typeof import('../src/service/spend.ts')['refundRequest'];
let ledger: typeof import('../src/ledger/ledger.ts')['ledger'];
let availableMinor: typeof import('../src/policy/engine.ts')['availableMinor'];

before(async () => {
  process.env.DATA_DIR = dir;
  process.env.PAYPAL_CLIENT_ID = '';
  process.env.PAYPAL_CLIENT_SECRET = '';
  process.env.AI_PROVIDER = 'builtin';

  ({ createMandate, getMandateOrThrow, revokeMandate } = await import('../src/service/mandates.ts'));
  ({ requestSpend, decideHuman, completeBuyerApproval, refundRequest } = await import('../src/service/spend.ts'));
  ({ ledger } = await import('../src/ledger/ledger.ts'));
  ({ availableMinor } = await import('../src/policy/engine.ts'));
});

after(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const baseMandate = () => ({
  label: 'Pipeline test',
  agentName: 'test-agent',
  currency: 'USD',
  budget: '2000.00',
  expiresIn: '7d',
  rules: {
    perTransactionCap: '600.00',
    autoApproveLimit: '250.00',
    velocity: { windowHours: 24, maxTransactions: 20, maxAmount: '1500.00' },
    merchantAllowlist: [],
    merchantDenylist: [],
    categoryAllowlist: [],
    categoryDenylist: ['gift-cards'],
    purpose: 'Keep the production data pipeline running: cloud compute, managed databases, storage and monitoring.',
    requireHumanForAll: false,
  },
});

describe('mandate creation guards', () => {
  test('rejects a cap larger than the budget', () => {
    const bad = baseMandate();
    bad.rules.perTransactionCap = '5000.00';
    assert.throws(() => createMandate(bad), /cannot exceed the total budget/);
  });

  test('rejects an autonomous limit above the per-transaction cap', () => {
    const bad = baseMandate();
    bad.rules.autoApproveLimit = '900.00';
    assert.throws(() => createMandate(bad), /cannot exceed the per-transaction cap/);
  });

  test('requires a purpose long enough to adjudicate against', () => {
    const bad = baseMandate();
    bad.rules.purpose = 'stuff';
    assert.throws(() => createMandate(bad));
  });
});

describe('autonomous settlement', () => {
  test('an in-purpose, in-limit spend settles without a human and debits the mandate', async () => {
    const m = createMandate(baseMandate());
    const before = availableMinor(getMandateOrThrow(m.id));

    const req = await requestSpend({
      mandateId: m.id,
      itemIds: ['nw-compute-std'],
      justification: 'The pipeline needs another standard cloud compute node to absorb this month of extra ingest volume.',
      agentName: 'test-agent',
    });

    assert.equal(req.status, 'SETTLED');
    assert.equal(req.rail, 'PAYOUT');
    assert.equal(req.policy?.decision, 'APPROVE');
    assert.equal(req.adjudication?.decision, 'APPROVE');
    assert.equal(req.settlement?.simulated, true);
    assert.ok(req.settlement?.paypalId, 'expected a payout batch reference');

    const after = getMandateOrThrow(m.id);
    assert.equal(after.spentMinor, 8400);
    assert.equal(after.reservedMinor, 0, 'the reservation must be released once settled');
    assert.equal(availableMinor(after), before - 8400);
  });

  test('concurrent requests cannot collectively overspend the budget', async () => {
    const small = baseMandate();
    small.budget = '200.00';
    small.rules.perTransactionCap = '100.00';
    small.rules.autoApproveLimit = '100.00';
    const m = createMandate(small);

    // Each $84 node passes a budget check in isolation; three of them do not
    // fit in $200. Reservations are what stop the third.
    const results = await Promise.all(
      [1, 2, 3].map(() =>
        requestSpend({
          mandateId: m.id,
          itemIds: ['nw-compute-std'],
          justification: 'Additional cloud compute node for pipeline ingest capacity.',
          agentName: 'test-agent',
        }),
      ),
    );

    const settled = results.filter((r) => r.status === 'SETTLED');
    const denied = results.filter((r) => r.status === 'DENIED');
    assert.equal(settled.length, 2, 'exactly two $84 payments fit inside a $200 budget');
    assert.equal(denied.length, 1);

    const after = getMandateOrThrow(m.id);
    assert.ok(after.spentMinor <= after.budgetMinor, 'the mandate must never be overspent');
    assert.equal(after.spentMinor, 16800);
  });
});

describe('AI adjudication', () => {
  test('denies a purchase that is inside every hard limit but outside the purpose', async () => {
    const m = createMandate(baseMandate());
    const req = await requestSpend({
      mandateId: m.id,
      itemIds: ['atlas-task-chair'],
      justification: 'The new backend hire starts Monday and needs an ergonomic chair at their desk.',
      agentName: 'test-agent',
    });

    assert.equal(req.status, 'DENIED');
    assert.notEqual(req.policy?.decision, 'DENY', 'no hard rule should have blocked this');
    assert.equal(req.adjudication?.decision, 'DENY');
    assert.equal(getMandateOrThrow(m.id).spentMinor, 0);
    assert.equal(getMandateOrThrow(m.id).reservedMinor, 0, 'a denial must not leave funds reserved');
  });

  test('skips the model entirely when a hard rule already denied the request', async () => {
    const m = createMandate(baseMandate());
    const req = await requestSpend({
      mandateId: m.id,
      itemIds: ['moonlit-gc-500'],
      justification: 'Team rewards for shipping the migration ahead of schedule.',
      agentName: 'test-agent',
    });

    assert.equal(req.status, 'DENIED');
    assert.equal(req.policy?.decision, 'DENY');
    assert.equal(req.policy?.terminal, true);
    assert.equal(req.adjudication, undefined, 'the adjudicator must not be consulted after a terminal denial');
  });
});

describe('human-in-the-loop rail', () => {
  test('escalates at the autonomous limit, then settles through authorize and capture', async () => {
    const m = createMandate(baseMandate());

    const req = await requestSpend({
      mandateId: m.id,
      itemIds: ['carto-enrich-50k'],
      justification: 'The customer dimension table needs a backfill of company enrichment data for the pipeline.',
      agentName: 'test-agent',
    });

    assert.equal(req.status, 'PENDING_HUMAN');
    assert.equal(req.rail, 'ORDER_AUTHORIZE');
    // Funds are held, not yet spent.
    let state = getMandateOrThrow(m.id);
    assert.equal(state.reservedMinor, 25000);
    assert.equal(state.spentMinor, 0);

    const approved = await decideHuman(req.id, { decision: 'APPROVE', by: 'priya@example.com', note: 'On the roadmap.' });
    assert.equal(approved.status, 'AWAITING_BUYER_APPROVAL');
    assert.ok(approved.settlement?.approvalUrl, 'the human must be handed a PayPal approval URL');
    assert.ok(approved.settlement?.paypalId, 'expected a PayPal order id');

    const captured = await completeBuyerApproval(req.id);
    assert.equal(captured.status, 'SETTLED');
    assert.ok(captured.settlement?.authorizationId);
    assert.ok(captured.settlement?.captureId);

    state = getMandateOrThrow(m.id);
    assert.equal(state.spentMinor, 25000);
    assert.equal(state.reservedMinor, 0);
  });

  test('a human denial releases the reservation', async () => {
    const m = createMandate(baseMandate());
    const req = await requestSpend({
      mandateId: m.id,
      itemIds: ['carto-enrich-50k'],
      justification: 'Backfill of company enrichment data for the pipeline customer dimension.',
      agentName: 'test-agent',
    });
    assert.equal(req.status, 'PENDING_HUMAN');
    assert.equal(getMandateOrThrow(m.id).reservedMinor, 25000);

    const denied = await decideHuman(req.id, { decision: 'DENY', by: 'priya@example.com', note: 'Not this quarter.' });
    assert.equal(denied.status, 'DENIED');

    const state = getMandateOrThrow(m.id);
    assert.equal(state.reservedMinor, 0);
    assert.equal(state.spentMinor, 0);
  });

  test('a mandate revoked while a request waits in the queue blocks the approval', async () => {
    const m = createMandate(baseMandate());
    const req = await requestSpend({
      mandateId: m.id,
      itemIds: ['carto-enrich-50k'],
      justification: 'Backfill of company enrichment data for the pipeline customer dimension.',
      agentName: 'test-agent',
    });
    assert.equal(req.status, 'PENDING_HUMAN');

    revokeMandate(m.id, { reason: 'Budget freeze' });

    const result = await decideHuman(req.id, { decision: 'APPROVE', by: 'someone@example.com', note: 'lgtm' });
    assert.equal(result.status, 'DENIED', 'approval must not resurrect a revoked mandate');
    assert.equal(getMandateOrThrow(m.id).spentMinor, 0);
    assert.equal(getMandateOrThrow(m.id).reservedMinor, 0);
  });

  test('a decision cannot be applied twice', async () => {
    const m = createMandate(baseMandate());
    const req = await requestSpend({
      mandateId: m.id,
      itemIds: ['carto-enrich-50k'],
      justification: 'Backfill of company enrichment data for the pipeline customer dimension.',
      agentName: 'test-agent',
    });
    await decideHuman(req.id, { decision: 'DENY', by: 'a@example.com', note: '' });
    await assert.rejects(
      () => decideHuman(req.id, { decision: 'APPROVE', by: 'b@example.com', note: '' }),
      /not awaiting a human decision/,
    );
  });
});

describe('spend-request integrity', () => {
  test('rejects items spanning multiple merchants', async () => {
    const m = createMandate(baseMandate());
    await assert.rejects(
      () => requestSpend({
        mandateId: m.id,
        itemIds: ['nw-compute-std', 'helio-metrics-pro'],
        justification: 'Cloud compute and monitoring for the production data pipeline.',
        agentName: 'test-agent',
      }),
      /must settle to one merchant/,
    );
  });

  test('rejects an understated amount that disagrees with the catalog price', async () => {
    const m = createMandate(baseMandate());
    // Declaring $9 for a $485 chair must not be accepted.
    await assert.rejects(
      () => requestSpend({
        mandateId: m.id,
        itemIds: ['atlas-task-chair'],
        amount: '9.00',
        justification: 'A chair for the office, cheap.',
        agentName: 'test-agent',
      }),
      /does not match the catalog total/,
    );
  });

  test('rejects an unknown item id', async () => {
    const m = createMandate(baseMandate());
    await assert.rejects(
      () => requestSpend({
        mandateId: m.id,
        itemIds: ['does-not-exist'],
        justification: 'Cloud compute for the production data pipeline ingest.',
        agentName: 'test-agent',
      }),
      /No catalog item/,
    );
  });

  test('rejects a spend against an unknown mandate', async () => {
    await assert.rejects(
      () => requestSpend({
        mandateId: 'mdt_nope',
        itemIds: ['nw-compute-std'],
        justification: 'Cloud compute for the production data pipeline ingest.',
        agentName: 'test-agent',
      }),
      /No mandate with id/,
    );
  });
});

describe('refunds', () => {
  test('refunds a captured Orders-rail payment and credits the mandate back', async () => {
    const m = createMandate(baseMandate());
    const req = await requestSpend({
      mandateId: m.id,
      itemIds: ['carto-enrich-50k'],
      justification: 'Backfill of company enrichment data for the pipeline customer dimension.',
      agentName: 'test-agent',
    });
    await decideHuman(req.id, { decision: 'APPROVE', by: 'p@example.com', note: '' });
    await completeBuyerApproval(req.id);
    assert.equal(getMandateOrThrow(m.id).spentMinor, 25000);

    const refunded = await refundRequest(req.id, { reason: 'Vendor could not deliver' });
    assert.equal(refunded.status, 'REFUNDED');
    assert.ok(refunded.settlement?.refundId);

    const state = getMandateOrThrow(m.id);
    assert.equal(state.spentMinor, 0);
    assert.equal(state.refundedMinor, 25000);
  });

  test('explains that a Payouts settlement has no refund API', async () => {
    const m = createMandate(baseMandate());
    const req = await requestSpend({
      mandateId: m.id,
      itemIds: ['nw-compute-std'],
      justification: 'Another cloud compute node for the production data pipeline.',
      agentName: 'test-agent',
    });
    assert.equal(req.status, 'SETTLED');
    await assert.rejects(() => refundRequest(req.id, {}), /no refund API/);
  });
});

describe('audit trail', () => {
  test('every decision leaves an intact, verifiable chain', async () => {
    const v = ledger().verify();
    assert.equal(v.valid, true, v.brokenAt ? `chain broken at ${v.brokenAt.seq}: ${v.brokenAt.reason}` : '');
    assert.ok(v.length > 20, 'the preceding tests should have produced a substantial trail');
  });

  test('a settled spend records the full reasoning sequence', async () => {
    const m = createMandate(baseMandate());
    const req = await requestSpend({
      mandateId: m.id,
      itemIds: ['helio-metrics-pro'],
      justification: 'Monitoring and alerting coverage for the production data pipeline services.',
      agentName: 'test-agent',
    });

    const types = ledger().list({ subject: req.id, limit: 50 }).map((e) => e.type).reverse();
    assert.deepEqual(types, [
      'SPEND_REQUESTED',
      'POLICY_EVALUATED',
      'AI_ADJUDICATED',
      'DECISION_APPLIED',
      'SETTLEMENT_ATTEMPTED',
      'SETTLEMENT_SUCCEEDED',
    ]);
  });
});
