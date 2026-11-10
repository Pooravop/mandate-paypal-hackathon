import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { toMinor, toDecimalString, format, orderAmount, payoutAmount, exponent } from '../src/util/money.ts';

describe('money: minor-unit conversion', () => {
  test('parses decimal strings exactly', () => {
    assert.equal(toMinor('10.99', 'USD'), 1099);
    assert.equal(toMinor('0.01', 'USD'), 1);
    assert.equal(toMinor('1000', 'USD'), 100000);
    assert.equal(toMinor('0.1', 'USD'), 10);
    assert.equal(toMinor('.5', 'USD'), 50);
  });

  test('truncates beyond the currency exponent rather than rounding up', () => {
    // PayPal would reject a third decimal place; silently rounding up would
    // overcharge, so extra precision is dropped.
    assert.equal(toMinor('10.999', 'USD'), 1099);
  });

  test('handles zero-decimal currencies', () => {
    assert.equal(exponent('JPY'), 0);
    assert.equal(toMinor('1200', 'JPY'), 1200);
    assert.equal(toDecimalString(1200, 'JPY'), '1200');
  });

  test('rejects non-numeric input instead of coercing it', () => {
    assert.throws(() => toMinor('ten', 'USD'), /Invalid monetary amount/);
    assert.throws(() => toMinor('', 'USD'), /Invalid monetary amount/);
    assert.throws(() => toMinor('1,000.00', 'USD'), /Invalid monetary amount/);
    assert.throws(() => toMinor('1e3', 'USD'), /Invalid monetary amount/);
  });

  test('round-trips through the decimal representation', () => {
    for (const minor of [0, 1, 7, 99, 100, 1099, 123456, 99999999]) {
      assert.equal(toMinor(toDecimalString(minor, 'USD'), 'USD'), minor);
    }
  });

  test('survives values that break naive float arithmetic', () => {
    // 0.1 + 0.2 in floats is 0.30000000000000004; integer cents cannot drift.
    const a = toMinor('0.1', 'USD');
    const b = toMinor('0.2', 'USD');
    assert.equal(toDecimalString(a + b, 'USD'), '0.30');
    assert.equal(toMinor('4.35', 'USD'), 435);
    assert.equal(toMinor('8.20', 'USD'), 820);
  });

  test('formats for humans', () => {
    assert.equal(format(1099, 'USD'), '$10.99');
    assert.equal(format(250000, 'USD'), '$2500.00');
    assert.equal(format(1200, 'JPY'), '¥1200');
    assert.equal(format(500, 'SEK'), 'SEK 5.00');
  });
});

describe('money: PayPal request shapes', () => {
  test('Orders and Payments v2 use currency_code', () => {
    assert.deepEqual(orderAmount(1099, 'usd'), { currency_code: 'USD', value: '10.99' });
  });

  test('Payouts v1 uses currency, not currency_code', () => {
    // This asymmetry is real and is the single easiest way to get a silent
    // 400 out of the Payouts API.
    assert.deepEqual(payoutAmount(1099, 'usd'), { currency: 'USD', value: '10.99' });
    assert.ok(!('currency_code' in payoutAmount(1099, 'USD')));
  });
});
