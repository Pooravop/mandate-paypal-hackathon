import { useState } from 'react';
import type { RuleResult, SpendRequest } from '../lib/api';
import { money, clockTime } from '../lib/format';
import { Badge, toneForStatus } from './ui';

/**
 * The full reasoning behind one spend request: deterministic rules first, then
 * the AI judgement, then what PayPal actually did.
 *
 * The visual order matters and mirrors the architecture -- a reader should be
 * able to see at a glance that code decided before the model was consulted,
 * and that the model never gets to overturn a hard rule.
 */

function RuleRow({ rule }: { rule: RuleResult }) {
  const [open, setOpen] = useState(false);
  const hasEvidence = rule.evidence && Object.keys(rule.evidence).length > 0;

  const mark =
    rule.status === 'PASS' ? (
      <span className="text-approve-400">&#10003;</span>
    ) : rule.status === 'FLAG' ? (
      <span className="text-escalate-400">!</span>
    ) : (
      <span className="text-deny-400">&#10007;</span>
    );

  return (
    <li
      className={`rounded-md border px-2 py-1.5 ${
        rule.status === 'FAIL'
          ? 'border-deny-500/30 bg-deny-500/5'
          : rule.status === 'FLAG'
            ? 'border-escalate-500/30 bg-escalate-500/5'
            : 'border-ink-700/60 bg-ink-850/40'
      }`}
    >
      <button
        type="button"
        onClick={() => hasEvidence && setOpen((o) => !o)}
        className={`flex w-full items-start gap-2 text-left ${hasEvidence ? 'cursor-pointer' : 'cursor-default'}`}
      >
        <span className="mt-0.5 w-3 shrink-0 text-center font-mono text-xs">{mark}</span>
        <span className="min-w-0 flex-1">
          <span className="font-mono text-[11px] text-ink-300">{rule.code}</span>
          <span className="ml-2 text-xs text-ink-400">{rule.detail}</span>
        </span>
        {hasEvidence && <span className="mt-0.5 shrink-0 font-mono text-[10px] text-ink-400">{open ? '−' : '+'}</span>}
      </button>
      {open && hasEvidence && (
        <pre className="mt-1.5 overflow-x-auto rounded bg-ink-950 p-2 font-mono text-[10px] leading-relaxed text-ink-300">
          {JSON.stringify(rule.evidence, null, 2)}
        </pre>
      )}
    </li>
  );
}

function Stage({
  index,
  title,
  verdict,
  meta,
  children,
}: {
  index: number;
  title: string;
  verdict?: string;
  meta?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="relative pl-7">
      <span className="absolute left-0 top-0.5 flex size-5 items-center justify-center rounded-full border border-ink-600 bg-ink-850 font-mono text-[10px] text-ink-300">
        {index}
      </span>
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="text-xs font-semibold text-ink-200">{title}</h4>
        {verdict && <Badge tone={toneForStatus(verdict)}>{verdict}</Badge>}
        {meta && <span className="font-mono text-[10px] text-ink-400">{meta}</span>}
      </div>
      {children && <div className="mt-1.5">{children}</div>}
    </div>
  );
}

export function DecisionTrail({ request, defaultOpenRules = false }: { request: SpendRequest; defaultOpenRules?: boolean }) {
  const [showAllRules, setShowAllRules] = useState(defaultOpenRules);

  const rules = request.policy?.rules ?? [];
  const notable = rules.filter((r) => r.status !== 'PASS');
  const visible = showAllRules ? rules : notable;
  const passed = rules.length - notable.length;

  return (
    <div className="space-y-4 border-l border-ink-700/70 pl-1">
      {/* Stage 1: deterministic rules */}
      {request.policy && (
        <Stage
          index={1}
          title="Policy engine"
          verdict={request.policy.decision}
          meta={`${passed} passed · ${notable.filter((r) => r.status === 'FLAG').length} flagged · ${notable.filter((r) => r.status === 'FAIL').length} failed`}
        >
          <p className="mb-1.5 text-xs text-ink-400">{request.policy.reason}</p>
          {visible.length > 0 && (
            <ul className="space-y-1">
              {visible.map((r) => (
                <RuleRow key={r.code} rule={r} />
              ))}
            </ul>
          )}
          {rules.length > 0 && (
            <button
              type="button"
              onClick={() => setShowAllRules((s) => !s)}
              className="mt-1.5 text-[11px] text-accent-400 hover:text-accent-300"
            >
              {showAllRules ? 'Show only flagged and failed rules' : `Show all ${rules.length} rules`}
            </button>
          )}
        </Stage>
      )}

      {/* Stage 2: AI intent adjudication */}
      {request.adjudication ? (
        <Stage
          index={2}
          title="AI intent adjudicator"
          verdict={request.adjudication.decision}
          meta={`${request.adjudication.provider}:${request.adjudication.model} · ${request.adjudication.confidence.toFixed(2)} confidence · ${request.adjudication.latencyMs}ms`}
        >
          <p className="text-xs leading-relaxed text-ink-300">{request.adjudication.rationale}</p>
          {request.adjudication.riskFlags.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {request.adjudication.riskFlags.map((f) => (
                <Badge key={f} tone="escalate" mono>
                  {f}
                </Badge>
              ))}
            </div>
          )}
          {request.adjudication.degraded && (
            <p className="mt-1.5 rounded border border-escalate-500/30 bg-escalate-500/5 p-1.5 text-[11px] text-escalate-400">
              Model unavailable, failed closed to human review: {request.adjudication.degraded}
            </p>
          )}
        </Stage>
      ) : (
        <Stage index={2} title="AI intent adjudicator" verdict={undefined}>
          <p className="text-xs text-ink-400">
            {request.policy?.terminal
              ? 'Not consulted — the deterministic rules already denied this request, and the model cannot overturn them.'
              : 'Not yet evaluated.'}
          </p>
        </Stage>
      )}

      {/* Stage 3: human decision, when one was needed */}
      {request.humanDecision && (
        <Stage
          index={3}
          title="Human decision"
          verdict={request.humanDecision.decision}
          meta={`${request.humanDecision.by} · ${clockTime(request.humanDecision.at)}`}
        >
          {request.humanDecision.note && <p className="text-xs italic text-ink-300">&ldquo;{request.humanDecision.note}&rdquo;</p>}
        </Stage>
      )}

      {/* Stage 4: what PayPal did */}
      {request.settlement && (
        <Stage
          index={request.humanDecision ? 4 : 3}
          title={request.settlement.rail === 'PAYOUT' ? 'Settlement — PayPal Payouts' : 'Settlement — PayPal Orders (authorize → capture)'}
          verdict={request.settlement.status}
          meta={request.settlement.simulated ? 'SIMULATED' : 'live sandbox call'}
        >
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 font-mono text-[11px]">
            {request.settlement.paypalId && (
              <>
                <dt className="text-ink-400">{request.settlement.rail === 'PAYOUT' ? 'payout batch' : 'order'}</dt>
                <dd className="truncate text-ink-300">{request.settlement.paypalId}</dd>
              </>
            )}
            {request.settlement.authorizationId && (
              <>
                <dt className="text-ink-400">authorization</dt>
                <dd className="truncate text-ink-300">{request.settlement.authorizationId}</dd>
              </>
            )}
            {request.settlement.captureId && (
              <>
                <dt className="text-ink-400">capture</dt>
                <dd className="truncate text-ink-300">{request.settlement.captureId}</dd>
              </>
            )}
            {request.settlement.refundId && (
              <>
                <dt className="text-ink-400">refund</dt>
                <dd className="truncate text-ink-300">{request.settlement.refundId}</dd>
              </>
            )}
          </dl>

          {request.settlement.approvalUrl && request.status === 'AWAITING_BUYER_APPROVAL' && (
            <a
              href={request.settlement.approvalUrl}
              target="_blank"
              rel="noreferrer"
              className="mt-2 inline-flex items-center gap-1.5 rounded-lg border border-escalate-500/50 bg-escalate-500/15 px-2.5 py-1.5 text-xs font-medium text-escalate-400 hover:bg-escalate-500/25"
            >
              Approve at PayPal &rarr;
            </a>
          )}

          {request.settlement.error && (
            <p className="mt-1.5 rounded border border-deny-500/30 bg-deny-500/5 p-1.5 font-mono text-[11px] text-deny-400">
              {request.settlement.error}
            </p>
          )}
        </Stage>
      )}

      {/* The agent's own words, clearly marked as untrusted input. */}
      <Stage index={0} title="Agent justification">
        <p className="rounded-md border border-ink-700 bg-ink-950/60 p-2 text-xs italic leading-relaxed text-ink-300">
          &ldquo;{request.justification}&rdquo;
        </p>
        <p className="mt-1 text-[10px] text-ink-400">
          Supplied by the agent. Treated as untrusted data by the adjudicator, never as instructions.
        </p>
      </Stage>
    </div>
  );
}

export function RequestHeader({ request }: { request: SpendRequest }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="truncate text-sm font-semibold text-ink-200">{request.description}</h3>
          <Badge tone={toneForStatus(request.status)}>{request.status.replace(/_/g, ' ')}</Badge>
          {request.settlement?.simulated && <Badge tone="muted">simulated</Badge>}
        </div>
        <p className="mt-0.5 text-xs text-ink-400">
          {request.merchantName} <span className="text-ink-600">&middot;</span> {request.category}{' '}
          <span className="text-ink-600">&middot;</span> requested by{' '}
          <span className="font-mono text-ink-300">{request.agentName}</span>
        </p>
      </div>
      <div className="text-right">
        <div className="font-mono text-base font-semibold tabular-nums text-ink-200">
          {money(request.amountMinor, request.currency)}
        </div>
        <div className="font-mono text-[10px] text-ink-400">{request.id}</div>
      </div>
    </div>
  );
}
