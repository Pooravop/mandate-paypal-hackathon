/**
 * Money is stored and reasoned about as integer minor units (cents) everywhere
 * inside Mandate. Floating point only ever appears at the PayPal API boundary,
 * where the REST API requires a decimal string such as "10.99".
 *
 * A budget control plane that loses a cent to float rounding is a broken
 * budget control plane, so the conversion lives in exactly one place.
 */

/** Currencies PayPal treats as having no decimal places. */
const ZERO_DECIMAL = new Set(['JPY', 'KRW', 'VND', 'CLP', 'ISK', 'HUF', 'TWD']);

export function exponent(currency: string): number {
  return ZERO_DECIMAL.has(currency.toUpperCase()) ? 0 : 2;
}

/** "10.99" / 10.99 -> 1099 minor units. Throws on anything non-numeric. */
export function toMinor(amount: string | number, currency: string): number {
  const text = typeof amount === 'number' ? amount.toFixed(exponent(currency)) : amount.trim();
  if (!/^-?(\d+(\.\d*)?|\.\d+)$/.test(text)) {
    throw new Error(`Invalid monetary amount: ${JSON.stringify(amount)}`);
  }
  const negative = text.startsWith('-');
  const [whole = '0', frac = ''] = text.replace('-', '').split('.');
  const exp = exponent(currency);
  const padded = (frac + '0'.repeat(exp)).slice(0, exp);
  const minor = Number(whole) * 10 ** exp + (exp === 0 ? 0 : Number(padded || '0'));
  if (!Number.isSafeInteger(minor)) throw new Error(`Amount out of range: ${text}`);
  return negative ? -minor : minor;
}

/** 1099 minor units -> "10.99", the exact string shape the PayPal REST API wants. */
export function toDecimalString(minor: number, currency: string): string {
  const exp = exponent(currency);
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(Math.round(minor));
  if (exp === 0) return `${sign}${abs}`;
  const whole = Math.floor(abs / 10 ** exp);
  const frac = String(abs % 10 ** exp).padStart(exp, '0');
  return `${sign}${whole}.${frac}`;
}

/** Human display, e.g. "$10.99" / "€10.99" / "USD 10.99". */
export function format(minor: number, currency: string): string {
  const symbols: Record<string, string> = { USD: '$', EUR: '\u20ac', GBP: '\u00a3', JPY: '\u00a5', INR: '\u20b9', AUD: 'A$', CAD: 'C$' };
  const sym = symbols[currency.toUpperCase()];
  const body = toDecimalString(minor, currency);
  return sym ? `${sym}${body}` : `${currency.toUpperCase()} ${body}`;
}

/** PayPal amount object for Orders v2 / Payments v2 (uses `currency_code`). */
export function orderAmount(minor: number, currency: string) {
  return { currency_code: currency.toUpperCase(), value: toDecimalString(minor, currency) };
}

/** PayPal amount object for Payouts v1 (uses `currency`, NOT `currency_code`). */
export function payoutAmount(minor: number, currency: string) {
  return { currency: currency.toUpperCase(), value: toDecimalString(minor, currency) };
}
