import { useEffect, useRef, useState } from 'react';
import { streamAgent, type AgentStep, type Mandate, type SpendRequest } from '../lib/api';
import { money } from '../lib/format';
import { Badge, Button, Empty, Panel, Spinner, toneForStatus } from './ui';
import { DecisionTrail, RequestHeader } from './DecisionTrail';

/**
 * Operator-facing agent console.
 *
 * The point of showing tool calls inline is that the agent's *intent* and the
 * control plane's *decision* are visible side by side. When the agent tries to
 * buy a desk out of an infrastructure budget, you watch it ask and you watch
 * the gate refuse, in one place.
 */

const SUGGESTIONS = [
  { label: 'In-purpose, settles autonomously', text: 'Ingest volume is up. Add another standard compute node and a terabyte of object storage.' },
  { label: 'Hits the approval ceiling', text: 'We need 50,000 company enrichment lookups to backfill the customer dimension table.' },
  { label: 'Outside the mandate purpose', text: 'Order an ergonomic task chair for the new backend hire starting Monday.' },
  { label: 'Blocked by hard rules', text: 'Buy the 500-unit gift card bundle as a team reward.' },
];

interface Turn {
  role: 'user' | 'agent';
  text: string;
  steps?: AgentStep[];
  meta?: string;
  error?: string;
}

function ToolCall({ step }: { step: AgentStep }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-md border border-ink-700 bg-ink-850/60">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-2 py-1.5 text-left"
      >
        <Badge tone="accent" mono>
          {step.tool}
        </Badge>
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-400">
          {step.input ? JSON.stringify(step.input) : ''}
        </span>
        <span className="font-mono text-[10px] text-ink-400">{open ? '−' : '+'}</span>
      </button>
      {open && (
        <pre className="overflow-x-auto border-t border-ink-700 p-2 font-mono text-[10px] leading-relaxed text-ink-300">
          {JSON.stringify(step.input ?? {}, null, 2)}
        </pre>
      )}
    </div>
  );
}

function ToolResult({ step }: { step: AgentStep }) {
  const [open, setOpen] = useState(false);
  let summary = step.output ?? '';
  try {
    const parsed = JSON.parse(step.output ?? '{}');
    if (parsed.result_count !== undefined) summary = `${parsed.result_count} items found`;
    else if (parsed.outcome) summary = `${parsed.outcome} — ${parsed.amount ?? ''}`;
    else if (parsed.error) summary = `error: ${parsed.error}`;
    else if (parsed.available) summary = `available ${parsed.available}, cap ${parsed.per_transaction_cap ?? '?'}`;
  } catch {
    /* keep the raw string */
  }

  return (
    <div className="rounded-md border border-ink-700/60 bg-ink-950/40">
      <button type="button" onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-2 px-2 py-1 text-left">
        <span className="font-mono text-[10px] text-ink-400">&rarr; result</span>
        <span className="min-w-0 flex-1 truncate text-[11px] text-ink-300">{summary}</span>
        <span className="font-mono text-[10px] text-ink-400">{open ? '−' : '+'}</span>
      </button>
      {open && (
        <pre className="max-h-72 overflow-auto border-t border-ink-700 p-2 font-mono text-[10px] leading-relaxed text-ink-300">
          {(() => {
            try {
              return JSON.stringify(JSON.parse(step.output ?? '{}'), null, 2);
            } catch {
              return step.output;
            }
          })()}
        </pre>
      )}
    </div>
  );
}

function SpendOutcome({ request }: { request: SpendRequest }) {
  const [open, setOpen] = useState(false);
  return (
    <div
      className={`rounded-lg border p-2.5 ${
        request.status === 'SETTLED'
          ? 'border-approve-500/40 bg-approve-500/5'
          : request.status === 'DENIED'
            ? 'border-deny-500/40 bg-deny-500/5'
            : 'border-escalate-500/40 bg-escalate-500/5'
      }`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={toneForStatus(request.status)}>{request.status.replace(/_/g, ' ')}</Badge>
          <span className="text-xs text-ink-300">{request.description}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="font-mono text-xs font-semibold tabular-nums text-ink-200">
            {money(request.amountMinor, request.currency)}
          </span>
          <Button size="sm" variant="ghost" onClick={() => setOpen((o) => !o)}>
            {open ? 'Hide trail' : 'Why?'}
          </Button>
        </div>
      </div>
      {open && (
        <div className="mt-3">
          <DecisionTrail request={request} />
        </div>
      )}
    </div>
  );
}

export function AgentConsole({ mandate, onActivity }: { mandate: Mandate | undefined; onActivity: () => void }) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [turns, busy]);

  // Abandon an in-flight turn if the operator switches mandate or leaves.
  useEffect(() => () => abortRef.current?.abort(), []);

  async function send(message: string): Promise<void> {
    if (!mandate || busy || !message.trim()) return;

    const history = turns
      .filter((t) => !t.error)
      .map((t) => ({ role: t.role === 'user' ? ('user' as const) : ('assistant' as const), text: t.text }));

    setTurns((t) => [...t, { role: 'user', text: message }, { role: 'agent', text: '', steps: [] }]);
    setDraft('');
    setBusy(true);

    const controller = new AbortController();
    abortRef.current = controller;

    const pushStep = (step: AgentStep) =>
      setTurns((t) => {
        const next = [...t];
        const last = next[next.length - 1];
        if (last && last.role === 'agent') {
          next[next.length - 1] = { ...last, steps: [...(last.steps ?? []), step] };
        }
        return next;
      });

    try {
      await streamAgent(
        { mandateId: mandate.id, message, history },
        {
          onStep: (step) => {
            pushStep(step);
            if (step.spendRequest) onActivity();
          },
          onDone: ({ reply, provider, model }) => {
            setTurns((t) => {
              const next = [...t];
              const last = next[next.length - 1];
              if (last && last.role === 'agent') {
                next[next.length - 1] = { ...last, text: reply, meta: `${provider}:${model}` };
              }
              return next;
            });
            onActivity();
          },
          onError: (msg) => {
            setTurns((t) => {
              const next = [...t];
              const last = next[next.length - 1];
              if (last && last.role === 'agent') next[next.length - 1] = { ...last, error: msg };
              return next;
            });
          },
        },
        controller.signal,
      );
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        const msg = (err as Error).message;
        setTurns((t) => {
          const next = [...t];
          const last = next[next.length - 1];
          if (last && last.role === 'agent') next[next.length - 1] = { ...last, error: msg };
          return next;
        });
      }
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  }

  if (!mandate) {
    return (
      <Panel title="Agent console">
        <Empty>Create or select a mandate to brief an agent.</Empty>
      </Panel>
    );
  }

  return (
    <Panel
      title="Agent console"
      subtitle={`Briefing ${mandate.agentName} · ${money(mandate.availableMinor, mandate.currency)} available · cap ${money(mandate.rules.perTransactionCapMinor, mandate.currency)} per transaction`}
      actions={busy ? <Spinner label="agent working" /> : undefined}
      bodyClassName="flex h-[32rem] flex-col gap-3"
    >
      <div ref={scrollRef} className="flex-1 space-y-4 overflow-y-auto pr-1">
        {turns.length === 0 && (
          <div className="space-y-3 py-2">
            <p className="text-xs text-ink-400">
              Ask the agent to buy something. It can search the catalog and submit spend requests, but it holds no PayPal
              credentials &mdash; every purchase has to clear the policy engine and the AI adjudicator first.
            </p>
            <div className="grid gap-1.5">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s.text}
                  type="button"
                  onClick={() => send(s.text)}
                  className="group rounded-lg border border-ink-700 bg-ink-850/50 px-3 py-2 text-left transition-colors hover:border-accent-500/50 hover:bg-ink-800"
                >
                  <span className="block text-[11px] uppercase tracking-wide text-ink-400 group-hover:text-accent-300">
                    {s.label}
                  </span>
                  <span className="mt-0.5 block text-xs text-ink-200">{s.text}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {turns.map((turn, i) =>
          turn.role === 'user' ? (
            <div key={i} className="flex justify-end">
              <p className="max-w-[85%] rounded-xl rounded-br-sm border border-accent-500/30 bg-accent-500/10 px-3 py-1.5 text-sm text-ink-200">
                {turn.text}
              </p>
            </div>
          ) : (
            <div key={i} className="space-y-2">
              {(turn.steps ?? []).map((step, j) => {
                if (step.type === 'assistant_text' && step.text) {
                  return (
                    <p key={j} className="text-sm leading-relaxed text-ink-200">
                      {step.text}
                    </p>
                  );
                }
                if (step.type === 'tool_call') return <ToolCall key={j} step={step} />;
                if (step.type === 'tool_result') {
                  return (
                    <div key={j} className="space-y-2">
                      <ToolResult step={step} />
                      {step.spendRequest && <SpendOutcome request={step.spendRequest} />}
                    </div>
                  );
                }
                if (step.type === 'error' && step.text) {
                  return (
                    <p key={j} className="rounded border border-deny-500/30 bg-deny-500/5 p-2 text-xs text-deny-400">
                      {step.text}
                    </p>
                  );
                }
                return null;
              })}

              {turn.error && (
                <p className="rounded border border-deny-500/30 bg-deny-500/5 p-2 text-xs text-deny-400">{turn.error}</p>
              )}
              {turn.meta && <p className="font-mono text-[10px] text-ink-400">{turn.meta}</p>}
            </div>
          ),
        )}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          send(draft);
        }}
        className="flex gap-2 border-t border-ink-700 pt-3"
      >
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Tell the agent what you need..."
          disabled={busy}
          className="flex-1 rounded-lg border border-ink-600 bg-ink-950 px-3 py-2 text-sm text-ink-200 placeholder:text-ink-400 focus:border-accent-500 focus:outline-none disabled:opacity-50"
        />
        <Button type="submit" variant="primary" disabled={busy || !draft.trim()}>
          Send
        </Button>
      </form>
    </Panel>
  );
}

export { RequestHeader };
