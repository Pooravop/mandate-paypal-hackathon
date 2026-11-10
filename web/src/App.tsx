import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  api,
  subscribeToEvents,
  setOperatorToken,
  type AppConfig,
  type LedgerEvent,
  type Mandate,
  type SpendRequest,
} from './lib/api';
import { money, relativeTime } from './lib/format';
import { Badge, Button, Empty, Panel, Spinner } from './components/ui';
import { MandateList } from './components/Mandates';
import { AgentConsole } from './components/AgentConsole';
import { Approvals } from './components/Approvals';
import { LedgerPanel } from './components/LedgerPanel';
import { DecisionTrail, RequestHeader } from './components/DecisionTrail';

/** Honest, prominent statement of whether money and model calls are real. */
function PostureBar({ config }: { config: AppConfig }) {
  const paypalLive = config.paypal.live;
  const aiLive = config.posture.ai.mode === 'llm';

  return (
    <div className="flex flex-wrap items-center gap-2 text-[11px]">
      <span
        className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 ${
          paypalLive ? 'border-approve-500/40 bg-approve-500/10 text-approve-400' : 'border-escalate-500/40 bg-escalate-500/10 text-escalate-400'
        }`}
        title={config.posture.paypal.detail}
      >
        <span className={`size-1.5 rounded-full ${paypalLive ? 'bg-approve-400' : 'bg-escalate-400'}`} />
        PayPal: {paypalLive ? `live ${config.paypal.env} API` : 'simulated locally'}
      </span>

      <span
        className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 ${
          aiLive ? 'border-approve-500/40 bg-approve-500/10 text-approve-400' : 'border-escalate-500/40 bg-escalate-500/10 text-escalate-400'
        }`}
        title={config.posture.ai.detail}
      >
        <span className={`size-1.5 rounded-full ${aiLive ? 'bg-approve-400' : 'bg-escalate-400'}`} />
        AI: {aiLive ? config.posture.ai.model : 'built-in reasoner'}
      </span>

      {paypalLive && config.paypal.receiverIsPlaceholder && (
        <span className="rounded-md border border-deny-500/40 bg-deny-500/10 px-2 py-1 text-deny-400">
          PAYPAL_PAYOUT_RECEIVER unset &mdash; payouts will fail
        </span>
      )}
      {config.paypal.credentialError && (
        <span className="rounded-md border border-deny-500/40 bg-deny-500/10 px-2 py-1 text-deny-400" title={config.paypal.credentialError}>
          credential error
        </span>
      )}
    </div>
  );
}

type Tab = 'console' | 'approvals' | 'activity' | 'ledger';

export default function App() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [mandates, setMandates] = useState<Mandate[]>([]);
  const [requests, setRequests] = useState<SpendRequest[]>([]);
  const [events, setEvents] = useState<LedgerEvent[]>([]);
  const [ledgerTotal, setLedgerTotal] = useState(0);
  const [selectedId, setSelectedId] = useState<string | undefined>();
  const [tab, setTab] = useState<Tab>('console');
  const [loading, setLoading] = useState(true);
  const [fatal, setFatal] = useState<string | null>(null);
  const [operator, setOperator] = useState('operator');
  const [tokenInput, setTokenInput] = useState('');
  const [seeding, setSeeding] = useState(false);

  const freshIds = useRef<Set<string>>(new Set());

  const refresh = useCallback(async () => {
    try {
      const [m, r, l] = await Promise.all([api.mandates(), api.requests(), api.ledger(250)]);
      setMandates(m.mandates);
      setRequests(r.requests);
      setEvents(l.events);
      setLedgerTotal(l.total);
      setSelectedId((cur) => cur ?? m.mandates.find((x) => x.status === 'ACTIVE')?.id ?? m.mandates[0]?.id);
      setFatal(null);
    } catch (err) {
      setFatal((err as Error).message);
    }
  }, []);

  useEffect(() => {
    (async () => {
      try {
        setConfig(await api.config());
        await refresh();
      } catch (err) {
        setFatal((err as Error).message);
      } finally {
        setLoading(false);
      }
    })();
  }, [refresh]);

  // Live tail of the audit ledger. Any event means some projection moved, so
  // the simplest correct response is to re-read the aggregates.
  useEffect(() => {
    return subscribeToEvents(
      (event) => {
        freshIds.current.add(event.id);
        setEvents((prev) => [event, ...prev].slice(0, 250));
        setLedgerTotal((t) => Math.max(t + 1, event.seq));
        void refresh();
      },
      () => void refresh(),
    );
  }, [refresh]);

  const selected = useMemo(() => mandates.find((m) => m.id === selectedId), [mandates, selectedId]);
  const pendingCount = requests.filter((r) => r.status === 'PENDING_HUMAN').length;
  const awaitingCount = requests.filter((r) => r.status === 'AWAITING_BUYER_APPROVAL').length;

  const visibleRequests = useMemo(
    () => (selectedId ? requests.filter((r) => r.mandateId === selectedId) : requests),
    [requests, selectedId],
  );

  async function seed(): Promise<void> {
    setSeeding(true);
    try {
      const { mandate } = await api.seedDemo();
      setSelectedId(mandate.id);
      await refresh();
    } catch (err) {
      setFatal((err as Error).message);
    } finally {
      setSeeding(false);
    }
  }

  if (loading) {
    return (
      <div className="grid min-h-screen place-items-center">
        <Spinner label="Connecting to the control plane..." />
      </div>
    );
  }

  const TABS: Array<{ id: Tab; label: string; badge?: number }> = [
    { id: 'console', label: 'Agent console' },
    { id: 'approvals', label: 'Approvals', badge: pendingCount + awaitingCount },
    { id: 'activity', label: 'Spend activity', badge: visibleRequests.length },
    { id: 'ledger', label: 'Audit ledger' },
  ];

  return (
    <div className="relative z-10 mx-auto max-w-7xl px-4 py-5 sm:px-6">
      <header className="mb-5">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold tracking-tight text-ink-200">
              Mandate
              <span className="ml-2 text-sm font-normal text-ink-400">payment control plane for AI agents</span>
            </h1>
            <p className="mt-1 max-w-2xl text-xs leading-relaxed text-ink-400">
              Agents get a budget with rules, not a card number. Deterministic policy runs first and cannot be argued with; an
              AI adjudicator then checks the purchase against what the mandate was actually for; PayPal settles only what
              survives both. Every step is hash-chained.
            </p>
          </div>
          <div className="flex flex-col items-end gap-2">
            {config && <PostureBar config={config} />}
            <div className="flex items-center gap-2">
              {config?.operatorTokenRequired && (
                <input
                  type="password"
                  value={tokenInput}
                  onChange={(e) => {
                    setTokenInput(e.target.value);
                    setOperatorToken(e.target.value);
                  }}
                  placeholder="operator token"
                  className="w-36 rounded-lg border border-ink-600 bg-ink-950 px-2 py-1 text-xs text-ink-200 placeholder:text-ink-400 focus:border-accent-500 focus:outline-none"
                />
              )}
              {mandates.length === 0 && (
                <Button size="sm" variant="primary" onClick={seed} disabled={seeding}>
                  {seeding ? 'Seeding...' : 'Seed demo mandate'}
                </Button>
              )}
            </div>
          </div>
        </div>
      </header>

      {fatal && (
        <p className="mb-4 rounded-lg border border-deny-500/40 bg-deny-500/10 p-3 text-xs text-deny-400">
          {fatal}
          <Button size="sm" variant="ghost" className="ml-2" onClick={() => void refresh()}>
            Retry
          </Button>
        </p>
      )}

      <div className="grid gap-4 lg:grid-cols-[22rem_1fr]">
        <aside className="space-y-4">
          <MandateList
            mandates={mandates}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onChange={() => void refresh()}
            currency={config?.currency ?? 'USD'}
          />
        </aside>

        <main className="space-y-4">
          <nav className="flex flex-wrap gap-1 rounded-xl border border-ink-700 bg-ink-900/70 p-1">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setTab(t.id)}
                className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                  tab === t.id ? 'bg-accent-500/15 text-accent-300' : 'text-ink-400 hover:bg-ink-800 hover:text-ink-200'
                }`}
              >
                {t.label}
                {t.badge !== undefined && t.badge > 0 && (
                  <span
                    className={`rounded px-1 font-mono text-[10px] ${
                      t.id === 'approvals' ? 'bg-escalate-500/20 text-escalate-400' : 'bg-ink-700 text-ink-300'
                    }`}
                  >
                    {t.badge}
                  </span>
                )}
              </button>
            ))}
          </nav>

          {tab === 'console' && <AgentConsole mandate={selected} onActivity={() => void refresh()} />}

          {tab === 'approvals' && (
            <Approvals
              requests={visibleRequests}
              onChange={() => void refresh()}
              operator={operator}
              onOperatorChange={setOperator}
            />
          )}

          {tab === 'activity' && <SpendActivity requests={visibleRequests} />}

          {tab === 'ledger' && <LedgerPanel events={events} total={ledgerTotal} freshIds={freshIds.current} />}
        </main>
      </div>

      <footer className="mt-6 border-t border-ink-700 pt-4 text-[11px] text-ink-400">
        <p>
          Built for the PayPal AI Hackathon. PayPal Payouts v1 settles autonomous spends; Orders v2 with{' '}
          <code className="font-mono text-ink-300">intent=AUTHORIZE</code> plus Payments v2 capture handles anything that needs
          a human. The same gate is exposed over MCP, so you can point your own agent at it.
        </p>
      </footer>
    </div>
  );
}

function SpendActivity({ requests }: { requests: SpendRequest[] }) {
  const [expanded, setExpanded] = useState<string | null>(null);

  if (requests.length === 0) {
    return (
      <Panel title="Spend activity">
        <Empty>No spend requests yet. Brief the agent in the console.</Empty>
      </Panel>
    );
  }

  const settled = requests.filter((r) => r.status === 'SETTLED');
  const totalSettled = settled.reduce((s, r) => s + r.amountMinor, 0);
  const currency = requests[0]?.currency ?? 'USD';

  return (
    <Panel
      title="Spend activity"
      subtitle={`${requests.length} requests · ${settled.length} settled · ${money(totalSettled, currency)} paid`}
      bodyClassName="space-y-2"
    >
      {requests.map((r) => (
        <article key={r.id} className="rounded-lg border border-ink-700 bg-ink-850/40 p-3">
          <button type="button" className="w-full text-left" onClick={() => setExpanded((e) => (e === r.id ? null : r.id))}>
            <RequestHeader request={r} />
            <p className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-ink-400">
              <span>{relativeTime(r.createdAt)}</span>
              {r.policy && (
                <>
                  <span className="text-ink-600">&middot;</span>
                  <span>policy {r.policy.decision}</span>
                </>
              )}
              {r.adjudication && (
                <>
                  <span className="text-ink-600">&middot;</span>
                  <span>AI {r.adjudication.decision}</span>
                </>
              )}
              {r.settlement?.rail && (
                <>
                  <span className="text-ink-600">&middot;</span>
                  <Badge tone="muted" mono>
                    {r.settlement.rail === 'PAYOUT' ? 'Payouts' : 'Orders'}
                  </Badge>
                </>
              )}
              <span className="ml-auto text-accent-400">{expanded === r.id ? 'hide trail' : 'show trail'}</span>
            </p>
          </button>
          {expanded === r.id && (
            <div className="mt-3 border-t border-ink-700 pt-3">
              <DecisionTrail request={r} />
            </div>
          )}
        </article>
      ))}
    </Panel>
  );
}
