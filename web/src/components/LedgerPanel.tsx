import { useEffect, useState } from 'react';
import { api, type LedgerEvent } from '../lib/api';
import { clockTime, shortHash } from '../lib/format';
import { Badge, Button, Empty, Panel } from './ui';

/**
 * The audit ledger.
 *
 * The verify button is the substantive part: it re-hashes the whole chain
 * server-side and reports the first event whose contents no longer match its
 * recorded hash. Editing data/events.jsonl by hand and pressing it is the
 * fastest way to see that the trail is tamper-evident rather than just
 * tamper-discouraged.
 */

const TYPE_TONE: Record<string, 'approve' | 'deny' | 'escalate' | 'accent' | 'neutral' | 'muted'> = {
  MANDATE_CREATED: 'accent',
  MANDATE_UPDATED: 'accent',
  MANDATE_REVOKED: 'deny',
  SPEND_REQUESTED: 'neutral',
  POLICY_EVALUATED: 'neutral',
  AI_ADJUDICATED: 'accent',
  DECISION_APPLIED: 'neutral',
  HUMAN_DECIDED: 'escalate',
  ESCALATED: 'escalate',
  BUYER_APPROVAL_REQUIRED: 'escalate',
  SETTLEMENT_ATTEMPTED: 'neutral',
  SETTLEMENT_SUCCEEDED: 'approve',
  SETTLEMENT_FAILED: 'deny',
  AUTHORIZATION_CAPTURED: 'approve',
  AUTHORIZATION_VOIDED: 'muted',
  PAYMENT_REFUNDED: 'muted',
  WEBHOOK_RECEIVED: 'muted',
  LEDGER_INITIALISED: 'muted',
};

function EventRow({ event, fresh }: { event: LedgerEvent; fresh: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <li className={`border-b border-ink-700/50 last:border-0 ${fresh ? 'flash-in' : ''}`}>
      <button type="button" onClick={() => setOpen((o) => !o)} className="flex w-full items-start gap-2 px-1 py-1.5 text-left">
        <span className="w-10 shrink-0 font-mono text-[10px] text-ink-400 tabular-nums">#{event.seq}</span>
        <span className="w-16 shrink-0 font-mono text-[10px] text-ink-400">{clockTime(event.at)}</span>
        <span className="w-44 shrink-0">
          <Badge tone={TYPE_TONE[event.type] ?? 'neutral'} mono>
            {event.type}
          </Badge>
        </span>
        <span className="min-w-0 flex-1 text-xs text-ink-300">{event.summary}</span>
        <span className="hidden shrink-0 font-mono text-[10px] text-ink-400 sm:block" title={`hash ${event.hash}`}>
          {shortHash(event.hash, 8)}
        </span>
      </button>
      {open && (
        <div className="px-2 pb-2">
          <dl className="mb-1.5 grid grid-cols-[auto_1fr] gap-x-3 font-mono text-[10px]">
            <dt className="text-ink-400">actor</dt>
            <dd className="text-ink-300">{event.actor}</dd>
            <dt className="text-ink-400">subject</dt>
            <dd className="truncate text-ink-300">{event.subject}</dd>
            <dt className="text-ink-400">prev</dt>
            <dd className="truncate text-ink-400">{event.prevHash}</dd>
            <dt className="text-ink-400">hash</dt>
            <dd className="truncate text-accent-300">{event.hash}</dd>
          </dl>
          <pre className="max-h-64 overflow-auto rounded bg-ink-950 p-2 font-mono text-[10px] leading-relaxed text-ink-300">
            {JSON.stringify(event.data, null, 2)}
          </pre>
        </div>
      )}
    </li>
  );
}

export function LedgerPanel({ events, total, freshIds }: { events: LedgerEvent[]; total: number; freshIds: Set<string> }) {
  const [verify, setVerify] = useState<{ valid: boolean; length: number; headHash: string; brokenAt?: { seq: number; reason: string } } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState('');

  // Re-verify whenever the chain grows, so the badge is never stale.
  useEffect(() => {
    api.verifyLedger().then(setVerify).catch(() => setVerify(null));
  }, [total]);

  async function check(): Promise<void> {
    setBusy(true);
    try {
      setVerify(await api.verifyLedger());
    } finally {
      setBusy(false);
    }
  }

  const shown = filter
    ? events.filter(
        (e) =>
          e.type.toLowerCase().includes(filter.toLowerCase()) ||
          e.summary.toLowerCase().includes(filter.toLowerCase()) ||
          e.subject.toLowerCase().includes(filter.toLowerCase()),
      )
    : events;

  return (
    <Panel
      title="Audit ledger"
      subtitle={`${total} hash-chained events · append-only · every projection is replayed from this log`}
      actions={
        <div className="flex items-center gap-2">
          {verify && (
            <Badge tone={verify.valid ? 'approve' : 'deny'}>
              {verify.valid ? `chain valid · ${verify.length} events` : `BROKEN at #${verify.brokenAt?.seq}`}
            </Badge>
          )}
          <Button size="sm" onClick={check} disabled={busy}>
            {busy ? 'Verifying...' : 'Verify chain'}
          </Button>
        </div>
      }
      bodyClassName="space-y-2"
    >
      {verify && !verify.valid && (
        <p className="rounded border border-deny-500/40 bg-deny-500/10 p-2 text-xs text-deny-400">
          <strong>Tampering detected.</strong> Event #{verify.brokenAt?.seq}: {verify.brokenAt?.reason}
        </p>
      )}

      <div className="flex items-center gap-2">
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter by event type, subject or summary..."
          className="flex-1 rounded-lg border border-ink-600 bg-ink-950 px-2.5 py-1.5 text-xs text-ink-200 placeholder:text-ink-400 focus:border-accent-500 focus:outline-none"
        />
        {verify && (
          <span className="hidden font-mono text-[10px] text-ink-400 lg:block" title={verify.headHash}>
            head {shortHash(verify.headHash, 12)}
          </span>
        )}
      </div>

      {shown.length === 0 ? (
        <Empty>{filter ? 'No events match that filter.' : 'No events yet.'}</Empty>
      ) : (
        <ul className="max-h-[32rem] overflow-y-auto">
          {shown.map((e) => (
            <EventRow key={e.id} event={e} fresh={freshIds.has(e.id)} />
          ))}
        </ul>
      )}
    </Panel>
  );
}
