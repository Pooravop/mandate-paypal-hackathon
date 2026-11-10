import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Ledger } from '../src/ledger/ledger.ts';
import { canonicalise, GENESIS_HASH } from '../src/ledger/hash.ts';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mandate-ledger-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('canonical serialisation', () => {
  test('is independent of key insertion order', () => {
    // Without this property, two structurally identical events could hash
    // differently and a valid chain would fail verification.
    assert.equal(canonicalise({ a: 1, b: 2 }), canonicalise({ b: 2, a: 1 }));
    assert.equal(canonicalise({ x: { p: 1, q: 2 } }), canonicalise({ x: { q: 2, p: 1 } }));
  });

  test('preserves array order, which is meaningful', () => {
    assert.notEqual(canonicalise([1, 2]), canonicalise([2, 1]));
  });

  test('treats undefined members as absent', () => {
    assert.equal(canonicalise({ a: 1, b: undefined }), canonicalise({ a: 1 }));
  });
});

describe('hash chain', () => {
  test('genesis event links to the zero hash', () => {
    const l = new Ledger(dir);
    const head = l.head();
    assert.equal(head?.seq, 1);
    assert.equal(head?.prevHash, GENESIS_HASH);
    assert.equal(head?.type, 'LEDGER_INITIALISED');
  });

  test('each event links to its predecessor', () => {
    const l = new Ledger(dir);
    const a = l.append({ type: 'SPEND_REQUESTED', subject: 's1', actor: 'agent', summary: 'one' });
    const b = l.append({ type: 'POLICY_EVALUATED', subject: 's1', actor: 'policy', summary: 'two' });
    assert.equal(b.prevHash, a.hash);
    assert.equal(b.seq, a.seq + 1);
    assert.equal(l.verify().valid, true);
  });

  test('verifies a chain reloaded from disk', () => {
    const l = new Ledger(dir);
    for (let i = 0; i < 25; i++) {
      l.append({ type: 'SPEND_REQUESTED', subject: `s${i}`, actor: 'agent', summary: `event ${i}` });
    }
    const expectedHead = l.head()?.hash;

    const reloaded = new Ledger(dir);
    const v = reloaded.verify();
    assert.equal(v.valid, true);
    assert.equal(v.length, 26);
    assert.equal(v.headHash, expectedHead);
  });

  test('detects an altered event body and names the event', () => {
    const l = new Ledger(dir);
    l.append({ type: 'SPEND_REQUESTED', subject: 's1', actor: 'agent', summary: 'original' });
    l.append({ type: 'SETTLEMENT_SUCCEEDED', subject: 's1', actor: 'paypal', summary: 'paid' });

    const file = path.join(dir, 'events.jsonl');
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    const tampered = JSON.parse(lines[1] as string);
    tampered.summary = 'something else entirely';
    lines[1] = JSON.stringify(tampered);
    fs.writeFileSync(file, lines.join('\n') + '\n');

    const v = new Ledger(dir).verify();
    assert.equal(v.valid, false);
    assert.equal(v.brokenAt?.seq, 2);
    assert.match(v.brokenAt?.reason ?? '', /does not match its recorded hash/);
  });

  test('detects a deleted event', () => {
    const l = new Ledger(dir);
    l.append({ type: 'SPEND_REQUESTED', subject: 's1', actor: 'agent', summary: 'one' });
    l.append({ type: 'SPEND_REQUESTED', subject: 's2', actor: 'agent', summary: 'two' });

    const file = path.join(dir, 'events.jsonl');
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    // Remove the middle event, which is how someone would hide a payment.
    fs.writeFileSync(file, [lines[0], lines[2]].join('\n') + '\n');

    const v = new Ledger(dir).verify();
    assert.equal(v.valid, false);
    assert.equal(v.brokenAt?.seq, 3);
  });

  test('detects a re-signed event whose predecessor link is wrong', () => {
    const l = new Ledger(dir);
    l.append({ type: 'SPEND_REQUESTED', subject: 's1', actor: 'agent', summary: 'one' });

    const file = path.join(dir, 'events.jsonl');
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    const e = JSON.parse(lines[1] as string);
    e.prevHash = 'f'.repeat(64);
    lines[1] = JSON.stringify(e);
    fs.writeFileSync(file, lines.join('\n') + '\n');

    const v = new Ledger(dir).verify();
    assert.equal(v.valid, false);
    assert.match(v.brokenAt?.reason ?? '', /Previous-hash link/);
  });
});

describe('projections', () => {
  test('rebuilds mandate accounting by replaying the log', () => {
    const l = new Ledger(dir);
    const mandate = {
      id: 'mdt_test',
      label: 'test',
      agentName: 'a',
      currency: 'USD',
      budgetMinor: 100000,
      reservedMinor: 0,
      spentMinor: 0,
      refundedMinor: 0,
      rules: {},
      status: 'ACTIVE',
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
    };
    l.append({ type: 'MANDATE_CREATED', subject: mandate.id, actor: 'op', summary: 'created', data: { mandate } });

    l.append({
      type: 'DECISION_APPLIED',
      subject: 'spr_1',
      actor: 'cp',
      summary: 'approved',
      data: { accounting: { mandateId: 'mdt_test', reservedDelta: 25000 } },
    });
    assert.equal(l.getMandate('mdt_test')?.reservedMinor, 25000);

    l.append({
      type: 'SETTLEMENT_SUCCEEDED',
      subject: 'spr_1',
      actor: 'paypal',
      summary: 'paid',
      data: { accounting: { mandateId: 'mdt_test', reservedDelta: -25000, spentDelta: 25000 } },
    });

    const after = l.getMandate('mdt_test');
    assert.equal(after?.reservedMinor, 0);
    assert.equal(after?.spentMinor, 25000);

    // The same position must come back from a cold replay.
    const replayed = new Ledger(dir).getMandate('mdt_test');
    assert.equal(replayed?.spentMinor, 25000);
    assert.equal(replayed?.reservedMinor, 0);
  });

  test('a refund moves money back out of spent', () => {
    const l = new Ledger(dir);
    const mandate = {
      id: 'm2', label: 't', agentName: 'a', currency: 'USD',
      budgetMinor: 100000, reservedMinor: 0, spentMinor: 0, refundedMinor: 0,
      rules: {}, status: 'ACTIVE', createdAt: '', expiresAt: '',
    };
    l.append({ type: 'MANDATE_CREATED', subject: 'm2', actor: 'op', summary: '', data: { mandate } });
    l.append({ type: 'SETTLEMENT_SUCCEEDED', subject: 's', actor: 'p', summary: '', data: { accounting: { mandateId: 'm2', spentDelta: 50000 } } });
    l.append({ type: 'PAYMENT_REFUNDED', subject: 's', actor: 'op', summary: '', data: { accounting: { mandateId: 'm2', spentDelta: -20000, refundedDelta: 20000 } } });

    const m = l.getMandate('m2');
    assert.equal(m?.spentMinor, 30000);
    assert.equal(m?.refundedMinor, 20000);
  });

  test('returns copies, so callers cannot mutate ledger state', () => {
    const l = new Ledger(dir);
    const mandate = {
      id: 'm3', label: 'orig', agentName: 'a', currency: 'USD',
      budgetMinor: 1, reservedMinor: 0, spentMinor: 0, refundedMinor: 0,
      rules: {}, status: 'ACTIVE', createdAt: '', expiresAt: '',
    };
    l.append({ type: 'MANDATE_CREATED', subject: 'm3', actor: 'op', summary: '', data: { mandate } });

    const got = l.getMandate('m3');
    (got as { label: string }).label = 'hacked';
    assert.equal(l.getMandate('m3')?.label, 'orig');
  });

  test('refuses to load a corrupt log rather than silently skipping lines', () => {
    const file = path.join(dir, 'events.jsonl');
    fs.writeFileSync(file, '{"seq":1,"not":"valid json"\n');
    assert.throws(() => new Ledger(dir), /Corrupt ledger/);
  });
});
