import type { ReactNode } from 'react';

/** Shared primitives, so every panel in the app reads as one instrument. */

export function Panel({
  title,
  subtitle,
  actions,
  children,
  className = '',
  bodyClassName = '',
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section className={`relative rounded-xl border border-ink-700 bg-ink-900/70 backdrop-blur-sm ${className}`}>
      {(title || actions) && (
        <header className="flex items-start justify-between gap-4 border-b border-ink-700 px-4 py-3">
          <div className="min-w-0">
            {title && <h2 className="text-sm font-semibold tracking-tight text-ink-200">{title}</h2>}
            {subtitle && <p className="mt-0.5 text-xs text-ink-400">{subtitle}</p>}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={`px-4 py-3 ${bodyClassName}`}>{children}</div>
    </section>
  );
}

type Tone = 'neutral' | 'accent' | 'approve' | 'escalate' | 'deny' | 'muted';

const TONES: Record<Tone, string> = {
  neutral: 'border-ink-600 bg-ink-800 text-ink-200',
  accent: 'border-accent-500/40 bg-accent-500/10 text-accent-300',
  approve: 'border-approve-500/40 bg-approve-500/10 text-approve-400',
  escalate: 'border-escalate-500/40 bg-escalate-500/10 text-escalate-400',
  deny: 'border-deny-500/40 bg-deny-500/10 text-deny-400',
  muted: 'border-ink-700 bg-ink-850 text-ink-400',
};

export function Badge({
  children,
  tone = 'neutral',
  mono = false,
  title,
}: {
  children: ReactNode;
  tone?: Tone;
  mono?: boolean;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1 whitespace-nowrap rounded-md border px-1.5 py-0.5 text-[11px] font-medium ${TONES[tone]} ${mono ? 'font-mono' : ''}`}
    >
      {children}
    </span>
  );
}

export function toneForStatus(status: string): Tone {
  if (status === 'SETTLED' || status === 'APPROVE' || status === 'APPROVED' || status === 'PASS' || status === 'ACTIVE') return 'approve';
  if (status === 'DENIED' || status === 'DENY' || status === 'FAIL' || status === 'SETTLEMENT_FAILED' || status === 'REVOKED') return 'deny';
  if (
    status === 'PENDING_HUMAN' ||
    status === 'ESCALATE' ||
    status === 'FLAG' ||
    status === 'AWAITING_BUYER_APPROVAL' ||
    status === 'EXPIRED'
  )
    return 'escalate';
  if (status === 'REFUNDED' || status === 'CANCELLED') return 'muted';
  return 'neutral';
}

export function Button({
  children,
  onClick,
  variant = 'default',
  size = 'md',
  disabled,
  type = 'button',
  title,
  className = '',
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: 'default' | 'primary' | 'approve' | 'deny' | 'ghost';
  size?: 'sm' | 'md';
  disabled?: boolean;
  type?: 'button' | 'submit';
  title?: string;
  className?: string;
}) {
  const variants: Record<string, string> = {
    default: 'border-ink-600 bg-ink-800 text-ink-200 hover:bg-ink-700',
    primary: 'border-accent-500 bg-accent-500 text-white hover:bg-accent-400',
    approve: 'border-approve-500/50 bg-approve-500/15 text-approve-400 hover:bg-approve-500/25',
    deny: 'border-deny-500/50 bg-deny-500/15 text-deny-400 hover:bg-deny-500/25',
    ghost: 'border-transparent bg-transparent text-ink-300 hover:bg-ink-800 hover:text-ink-200',
  };
  const sizes: Record<string, string> = { sm: 'px-2 py-1 text-xs', md: 'px-3 py-1.5 text-sm' };
  return (
    <button
      type={type}
      title={title}
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex items-center justify-center gap-1.5 rounded-lg border font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${variants[variant]} ${sizes[size]} ${className}`}
    >
      {children}
    </button>
  );
}

/**
 * Budget meter. Spent and reserved are stacked because the distinction is the
 * whole point: reserved money is committed but not yet captured, and an
 * operator needs to see it is already gone from what the agent can spend.
 */
export function BudgetMeter({
  budgetMinor,
  spentMinor,
  reservedMinor,
}: {
  budgetMinor: number;
  spentMinor: number;
  reservedMinor: number;
}) {
  const safe = Math.max(1, budgetMinor);
  const spentPct = Math.min(100, (spentMinor / safe) * 100);
  const reservedPct = Math.min(100 - spentPct, (reservedMinor / safe) * 100);

  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-ink-800" role="img" aria-label="Budget utilisation">
      <div className="flex h-full">
        <div className="h-full bg-approve-500 transition-all duration-500" style={{ width: `${spentPct}%` }} title="Settled" />
        <div
          className="h-full bg-escalate-500/70 transition-all duration-500"
          style={{ width: `${reservedPct}%` }}
          title="Reserved, awaiting capture"
        />
      </div>
    </div>
  );
}

export function Stat({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: string; tone?: Tone }) {
  const colour =
    tone === 'approve' ? 'text-approve-400' : tone === 'deny' ? 'text-deny-400' : tone === 'escalate' ? 'text-escalate-400' : 'text-ink-200';
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wide text-ink-400">{label}</div>
      <div className={`mt-0.5 font-mono text-sm font-semibold tabular-nums ${colour}`}>{value}</div>
      {hint && <div className="text-[11px] text-ink-400">{hint}</div>}
    </div>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="text-[11px] font-medium uppercase tracking-wide text-ink-400">{label}</span>
      {children}
      {hint && <span className="mt-0.5 block text-[11px] text-ink-400">{hint}</span>}
    </label>
  );
}

export const inputClass =
  'mt-1 w-full rounded-lg border border-ink-600 bg-ink-950 px-2.5 py-1.5 text-sm text-ink-200 placeholder:text-ink-400 focus:border-accent-500 focus:outline-none';

export function Empty({ children }: { children: ReactNode }) {
  return <p className="py-6 text-center text-sm text-ink-400">{children}</p>;
}

export function Spinner({ label }: { label?: string }) {
  return (
    <span className="inline-flex items-center gap-2 text-xs text-ink-400">
      <span className="size-1.5 rounded-full bg-accent-400 pulse-dot" />
      {label}
    </span>
  );
}
