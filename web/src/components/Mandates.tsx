import { useState } from 'react';
import { api, type Mandate } from '../lib/api';
import { money, relativeTime } from '../lib/format';
import { Badge, BudgetMeter, Button, Empty, Field, Panel, Stat, inputClass, toneForStatus } from './ui';

/** Mandate list, with the grant form and the revoke kill switch. */

function Rule({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2 text-[11px]">
      <span className="text-ink-400">{label}</span>
      <span className="font-mono text-ink-300">{value}</span>
    </div>
  );
}

export function MandateCard({
  mandate,
  selected,
  onSelect,
  onChange,
}: {
  mandate: Mandate;
  selected: boolean;
  onSelect: () => void;
  onChange: () => void;
}) {
  const [revoking, setRevoking] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cur = mandate.currency;
  const utilisation = mandate.budgetMinor > 0 ? ((mandate.spentMinor + mandate.reservedMinor) / mandate.budgetMinor) * 100 : 0;

  async function revoke(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await api.revokeMandate(mandate.id, reason.trim() || 'Revoked by operator');
      setRevoking(false);
      setReason('');
      onChange();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <article
      className={`rounded-xl border p-3 transition-colors ${
        selected ? 'border-accent-500/60 bg-accent-500/5' : 'border-ink-700 bg-ink-850/40 hover:border-ink-600'
      }`}
    >
      <button type="button" onClick={onSelect} className="w-full text-left">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-1.5">
              <h3 className="truncate text-sm font-semibold text-ink-200">{mandate.label}</h3>
              <Badge tone={toneForStatus(mandate.status)}>{mandate.status}</Badge>
            </div>
            <p className="mt-0.5 text-[11px] text-ink-400">
              granted to <span className="font-mono text-ink-300">{mandate.agentName}</span>
              <span className="text-ink-600"> &middot; </span>
              {mandate.status === 'ACTIVE' ? `expires ${relativeTime(mandate.expiresAt)}` : `expired ${relativeTime(mandate.expiresAt)}`}
            </p>
          </div>
          <div className="text-right">
            <div className="font-mono text-sm font-semibold tabular-nums text-ink-200">{money(mandate.availableMinor, cur)}</div>
            <div className="text-[10px] text-ink-400">available</div>
          </div>
        </div>

        <div className="mt-2.5">
          <BudgetMeter budgetMinor={mandate.budgetMinor} spentMinor={mandate.spentMinor} reservedMinor={mandate.reservedMinor} />
          <div className="mt-1 flex justify-between text-[10px] text-ink-400">
            <span>
              <span className="text-approve-400">{money(mandate.spentMinor, cur)} settled</span>
              {mandate.reservedMinor > 0 && (
                <>
                  <span className="text-ink-600"> &middot; </span>
                  <span className="text-escalate-400">{money(mandate.reservedMinor, cur)} reserved</span>
                </>
              )}
              {mandate.refundedMinor > 0 && (
                <>
                  <span className="text-ink-600"> &middot; </span>
                  <span>{money(mandate.refundedMinor, cur)} refunded</span>
                </>
              )}
            </span>
            <span>
              {utilisation.toFixed(0)}% of {money(mandate.budgetMinor, cur)}
            </span>
          </div>
        </div>
      </button>

      {selected && (
        <div className="mt-3 space-y-2 border-t border-ink-700 pt-2.5">
          <p className="text-[11px] leading-relaxed text-ink-300">
            <span className="text-ink-400">Purpose: </span>
            {mandate.rules.purpose}
          </p>
          <div className="space-y-0.5">
            <Rule label="Per-transaction cap" value={money(mandate.rules.perTransactionCapMinor, cur)} />
            <Rule label="Autonomous limit" value={money(mandate.rules.autoApproveLimitMinor, cur)} />
            <Rule
              label="Velocity"
              value={`${mandate.rules.velocity.maxTransactions} txns / ${money(mandate.rules.velocity.maxAmountMinor, cur)} per ${mandate.rules.velocity.windowHours}h`}
            />
            {mandate.rules.categoryDenylist.length > 0 && (
              <Rule label="Denied categories" value={mandate.rules.categoryDenylist.join(', ')} />
            )}
            {mandate.rules.merchantAllowlist.length > 0 && (
              <Rule label="Merchant allowlist" value={mandate.rules.merchantAllowlist.join(', ')} />
            )}
            {mandate.rules.requireHumanForAll && <Rule label="Human approval" value="required for every spend" />}
          </div>

          {mandate.status === 'ACTIVE' &&
            (revoking ? (
              <div className="space-y-2 rounded-lg border border-deny-500/30 bg-deny-500/5 p-2">
                <p className="text-[11px] text-deny-400">
                  Revoking is immediate and permanent. Already-settled payments cannot be undone, but no further spend will be
                  authorised.
                </p>
                <input
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="Reason (recorded in the ledger)"
                  className="w-full rounded border border-ink-600 bg-ink-950 px-2 py-1 text-xs text-ink-200 placeholder:text-ink-400 focus:border-deny-500 focus:outline-none"
                />
                <div className="flex gap-2">
                  <Button size="sm" variant="deny" onClick={revoke} disabled={busy}>
                    {busy ? 'Revoking...' : 'Confirm revoke'}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setRevoking(false)}>
                    Cancel
                  </Button>
                </div>
                {error && <p className="text-[11px] text-deny-400">{error}</p>}
              </div>
            ) : (
              <Button size="sm" variant="deny" onClick={() => setRevoking(true)}>
                Revoke mandate
              </Button>
            ))}

          {mandate.status === 'REVOKED' && mandate.revokedReason && (
            <p className="rounded border border-deny-500/30 bg-deny-500/5 p-2 text-[11px] text-deny-400">
              Revoked: {mandate.revokedReason}
            </p>
          )}
        </div>
      )}
    </article>
  );
}

const DEFAULTS = {
  label: 'Production infrastructure - November',
  agentName: 'infra-ops-agent',
  budget: '2000.00',
  perTransactionCap: '600.00',
  autoApproveLimit: '250.00',
  expiresIn: '30d',
  windowHours: '24',
  maxTransactions: '8',
  maxAmount: '1200.00',
  categoryDenylist: 'gift-cards',
  purpose:
    'Keep the production data pipeline running: cloud compute, managed databases, object storage, monitoring and observability, on-call paging, and data enrichment APIs that the pipeline depends on.',
  requireHumanForAll: false,
};

export function GrantMandate({ onCreated, currency }: { onCreated: () => void; currency: string }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(DEFAULTS);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = <K extends keyof typeof DEFAULTS>(key: K, value: (typeof DEFAULTS)[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  async function submit(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await api.createMandate({
        label: form.label,
        agentName: form.agentName,
        currency,
        budget: form.budget,
        expiresIn: form.expiresIn,
        rules: {
          perTransactionCap: form.perTransactionCap,
          autoApproveLimit: form.autoApproveLimit,
          velocity: {
            windowHours: Number(form.windowHours),
            maxTransactions: Number(form.maxTransactions),
            maxAmount: form.maxAmount,
          },
          merchantAllowlist: [],
          merchantDenylist: [],
          categoryAllowlist: [],
          categoryDenylist: form.categoryDenylist
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
          purpose: form.purpose,
          requireHumanForAll: form.requireHumanForAll,
        },
      });
      setOpen(false);
      onCreated();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <Button variant="primary" size="sm" onClick={() => setOpen(true)}>
        Grant a mandate
      </Button>
    );
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-ink-950/80 p-4 backdrop-blur-sm">
      <Panel
        title="Grant a spending mandate"
        subtitle="The purpose is not decoration — it is what the AI adjudicator holds every spend against."
        className="max-h-[90vh] w-full max-w-2xl overflow-y-auto"
        actions={
          <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
            Close
          </Button>
        }
        bodyClassName="space-y-3"
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Label">
            <input className={inputClass} value={form.label} onChange={(e) => set('label', e.target.value)} />
          </Field>
          <Field label="Agent identity" hint="Recorded against every request this agent makes">
            <input className={inputClass} value={form.agentName} onChange={(e) => set('agentName', e.target.value)} />
          </Field>
        </div>

        <Field label={`Purpose (${currency})`} hint="Be specific. A vague purpose makes intent adjudication unreliable.">
          <textarea
            className={`${inputClass} min-h-20 resize-y`}
            value={form.purpose}
            onChange={(e) => set('purpose', e.target.value)}
          />
        </Field>

        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Total budget">
            <input className={inputClass} value={form.budget} onChange={(e) => set('budget', e.target.value)} />
          </Field>
          <Field label="Per-transaction cap" hint="Hard ceiling, never overridable">
            <input
              className={inputClass}
              value={form.perTransactionCap}
              onChange={(e) => set('perTransactionCap', e.target.value)}
            />
          </Field>
          <Field label="Autonomous limit" hint="At or above this, a human must approve">
            <input
              className={inputClass}
              value={form.autoApproveLimit}
              onChange={(e) => set('autoApproveLimit', e.target.value)}
            />
          </Field>
        </div>

        <div className="grid gap-3 sm:grid-cols-4">
          <Field label="Expires in">
            <input className={inputClass} value={form.expiresIn} onChange={(e) => set('expiresIn', e.target.value)} />
          </Field>
          <Field label="Velocity window (h)">
            <input className={inputClass} value={form.windowHours} onChange={(e) => set('windowHours', e.target.value)} />
          </Field>
          <Field label="Max txns / window">
            <input
              className={inputClass}
              value={form.maxTransactions}
              onChange={(e) => set('maxTransactions', e.target.value)}
            />
          </Field>
          <Field label="Max amount / window">
            <input className={inputClass} value={form.maxAmount} onChange={(e) => set('maxAmount', e.target.value)} />
          </Field>
        </div>

        <Field label="Denied categories" hint="Comma separated. Blocked by code before the model is consulted.">
          <input
            className={inputClass}
            value={form.categoryDenylist}
            onChange={(e) => set('categoryDenylist', e.target.value)}
          />
        </Field>

        <label className="flex items-center gap-2 text-xs text-ink-300">
          <input
            type="checkbox"
            checked={form.requireHumanForAll}
            onChange={(e) => set('requireHumanForAll', e.target.checked)}
            className="size-3.5 rounded border-ink-600 bg-ink-950"
          />
          Require human approval for every spend, regardless of amount
        </label>

        {error && <p className="rounded border border-deny-500/30 bg-deny-500/5 p-2 text-xs text-deny-400">{error}</p>}

        <div className="flex justify-end gap-2 border-t border-ink-700 pt-3">
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} disabled={busy}>
            {busy ? 'Granting...' : 'Grant mandate'}
          </Button>
        </div>
      </Panel>
    </div>
  );
}

export function MandateList({
  mandates,
  selectedId,
  onSelect,
  onChange,
  currency,
}: {
  mandates: Mandate[];
  selectedId: string | undefined;
  onSelect: (id: string) => void;
  onChange: () => void;
  currency: string;
}) {
  const totalBudget = mandates.reduce((s, m) => s + m.budgetMinor, 0);
  const totalSpent = mandates.reduce((s, m) => s + m.spentMinor, 0);
  const totalReserved = mandates.reduce((s, m) => s + m.reservedMinor, 0);

  return (
    <Panel
      title="Mandates"
      subtitle={`${mandates.filter((m) => m.status === 'ACTIVE').length} active of ${mandates.length}`}
      actions={<GrantMandate onCreated={onChange} currency={currency} />}
      bodyClassName="space-y-3"
    >
      {mandates.length > 0 && (
        <div className="grid grid-cols-3 gap-3 rounded-lg border border-ink-700 bg-ink-850/40 p-3">
          <Stat label="Authorised" value={money(totalBudget, currency)} />
          <Stat label="Settled" value={money(totalSpent, currency)} tone="approve" />
          <Stat label="Reserved" value={money(totalReserved, currency)} tone="escalate" />
        </div>
      )}

      {mandates.length === 0 ? (
        <Empty>No mandates yet. Grant one, or seed the demo mandate from the header.</Empty>
      ) : (
        mandates.map((m) => (
          <MandateCard
            key={m.id}
            mandate={m}
            selected={m.id === selectedId}
            onSelect={() => onSelect(m.id)}
            onChange={onChange}
          />
        ))
      )}
    </Panel>
  );
}
