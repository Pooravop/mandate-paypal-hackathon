const ZERO_DECIMAL = new Set(['JPY', 'KRW', 'VND', 'CLP', 'ISK', 'HUF', 'TWD']);
const SYMBOLS: Record<string, string> = { USD: '$', EUR: '€', GBP: '£', JPY: '¥', INR: '₹', AUD: 'A$', CAD: 'C$' };

export function money(minor: number, currency = 'USD'): string {
  const exp = ZERO_DECIMAL.has(currency.toUpperCase()) ? 0 : 2;
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(minor);
  const whole = Math.floor(abs / 10 ** exp);
  const body =
    exp === 0
      ? whole.toLocaleString('en-US')
      : `${whole.toLocaleString('en-US')}.${String(abs % 10 ** exp).padStart(exp, '0')}`;
  const sym = SYMBOLS[currency.toUpperCase()];
  return sym ? `${sign}${sym}${body}` : `${sign}${currency.toUpperCase()} ${body}`;
}

export function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return iso;
  const diff = Date.now() - then;
  const abs = Math.abs(diff);
  if (abs < 10_000) return 'just now';
  if (abs < 60_000) return `${Math.round(abs / 1000)}s ${diff < 0 ? 'from now' : 'ago'}`;
  if (abs < 3_600_000) return `${Math.round(abs / 60_000)}m ${diff < 0 ? 'from now' : 'ago'}`;
  if (abs < 86_400_000) return `${Math.round(abs / 3_600_000)}h ${diff < 0 ? 'from now' : 'ago'}`;
  return `${Math.round(abs / 86_400_000)}d ${diff < 0 ? 'from now' : 'ago'}`;
}

export function clockTime(iso: string): string {
  const d = new Date(iso);
  return Number.isFinite(d.getTime())
    ? d.toLocaleTimeString('en-GB', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : iso;
}

/** Readable label for a SCREAMING_SNAKE code. */
export function humanise(code: string): string {
  return code
    .toLowerCase()
    .replace(/_/g, ' ')
    .replace(/^./, (c) => c.toUpperCase());
}

export function shortHash(hash: string, chars = 10): string {
  return hash ? `${hash.slice(0, chars)}…` : '';
}
