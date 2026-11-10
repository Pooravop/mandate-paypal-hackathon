import { useState } from 'react';
import { api, type SpendRequest } from '../lib/api';
import { money, relativeTime } from '../lib/format';
import { Badge, Button, Empty, Panel } from './ui';
import { DecisionTrail, RequestHeader } from './DecisionTrail';

/**
 * The human approval queue.
 *
 * Everything the reviewer needs to decide is on screen before they act: which
 * rules flagged, what the adjudicator thought and why, and the agent's own
 * words marked as untrusted. Approving here does not pay anyone -- it creates
 * a real PayPal order and hands back PayPal's approval URL, so the final
 * consent happens at PayPal under the reviewer's own login.
 */
export function Approvals({
  requests,
  onChange,
  operator,
  onOperatorChange,
}: {
  requests: SpendRequest[];
  onChange: () => void;
  operator: string;
  onOperatorChange: (v: string) => void;
}) {
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const pending = requests.filter((r) => r.status === 'PENDING_HUMAN');
  const awaitingBuyer = requests.filter((r) => r.status === 'AWAITING_BUYER_APPROVAL');

  async function decide(id: string, decision: 'APPROVE' | 'DENY'): Promise<void> {
    setBusy(id);
    setError(null);
    try {
      await api.decide(id, decision, operator.trim() || 'operator', notes[id] ?? '');
      setNotes((n) => ({ ...n, [id]: '' }));
      onChange();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <Panel
      title="Approval queue"
      subtitle={
        pending.length === 0
          ? 'Nothing is waiting on a human right now'
          : `${pending.length} spend ${pending.length === 1 ? 'request needs' : 'requests need'} a decision`
      }
      actions={
        <input
          value={operator}
          onChange={(e) => onOperatorChange(e.target.value)}
          placeholder="your name"
          title="Recorded in the audit ledger against your decision"
          className="w-36 rounded-lg border border-ink-600 bg-ink-950 px-2 py-1 text-xs text-ink-200 placeholder:text-ink-400 focus:border-accent-500 focus:outline-none"
        />
      }
      bodyClassName="space-y-3"
    >
      {error && <p className="rounded border border-deny-500/30 bg-deny-500/5 p-2 text-xs text-deny-400">{error}</p>}

      {awaitingBuyer.length > 0 && (
        <div className="space-y-2 rounded-lg border border-escalate-500/30 bg-escalate-500/5 p-3">
          <h3 className="text-xs font-semibold text-escalate-400">Approved, waiting for approval at PayPal</h3>
          {awaitingBuyer.map((r) => (
            <div key={r.id} className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs text-ink-300">
                {r.description} <span className="text-ink-600">&middot;</span>{' '}
                <span className="font-mono">{money(r.amountMinor, r.currency)}</span> to {r.merchantName}
              </span>
              {r.settlement?.approvalUrl && (
                <a
                  href={r.settlement.approvalUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="rounded-lg border border-escalate-500/50 bg-escalate-500/15 px-2.5 py-1 text-xs font-medium text-escalate-400 hover:bg-escalate-500/25"
                >
                  Complete at PayPal &rarr;
                </a>
              )}
            </div>
          ))}
        </div>
      )}

      {pending.length === 0 && awaitingBuyer.length === 0 && (
        <Empty>
          Spends that clear every rule and the adjudicator settle on their own. Anything at or above the mandate&rsquo;s
          autonomous limit, or that the adjudicator is unsure about, surfaces here.
        </Empty>
      )}

      {pending.map((r) => (
        <article key={r.id} className="rounded-lg border border-escalate-500/30 bg-ink-850/40 p-3">
          <RequestHeader request={r} />
          <p className="mt-1 text-[11px] text-ink-400">
            Escalated {relativeTime(r.updatedAt)}
            {r.policy?.forcesHuman && (
              <>
                {' '}
                <Badge tone="escalate">mandate requires human approval</Badge>
              </>
            )}
          </p>

          <div className="mt-3">
            <DecisionTrail request={r} />
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-ink-700 pt-3">
            <input
              value={notes[r.id] ?? ''}
              onChange={(e) => setNotes((n) => ({ ...n, [r.id]: e.target.value }))}
              placeholder="Note for the audit trail (optional)"
              className="min-w-48 flex-1 rounded-lg border border-ink-600 bg-ink-950 px-2.5 py-1.5 text-xs text-ink-200 placeholder:text-ink-400 focus:border-accent-500 focus:outline-none"
            />
            <Button variant="deny" onClick={() => decide(r.id, 'DENY')} disabled={busy === r.id}>
              Deny
            </Button>
            <Button variant="approve" onClick={() => decide(r.id, 'APPROVE')} disabled={busy === r.id}>
              {busy === r.id ? 'Working...' : 'Approve'}
            </Button>
          </div>
        </article>
      ))}
    </Panel>
  );
}
