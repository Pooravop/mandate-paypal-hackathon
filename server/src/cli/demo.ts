import { config, posture } from '../config.ts';
import { ledger } from '../ledger/ledger.ts';
import { format } from '../util/money.ts';
import { availableMinor } from '../policy/engine.ts';
import { seedDemo } from '../service/demo.ts';
import { getMandateOrThrow } from '../service/mandates.ts';
import { completeBuyerApproval, decideHuman, requestSpend } from '../service/spend.ts';
import type { SpendRequest } from '../types.ts';

/**
 * Scripted end-to-end walkthrough.
 *
 * Runs the four outcomes the control plane exists to distinguish, in order,
 * against whatever posture is configured -- real PayPal sandbox calls if
 * credentials are present, local simulation otherwise. Written so a reviewer
 * can read the output top to bottom and see both the decision and the reason
 * for it at every step.
 *
 *   npm run demo            keep the existing ledger
 *   npm run demo -- --reset start from an empty audit chain
 */

const DIM = '\u001b[2m';
const BOLD = '\u001b[1m';
const RESET = '\u001b[0m';
const GREEN = '\u001b[32m';
const RED = '\u001b[31m';
const YELLOW = '\u001b[33m';
const CYAN = '\u001b[36m';

const out = (s = '') => process.stdout.write(s + '\n');
const rule = (ch = '-') => out(DIM + ch.repeat(74) + RESET);

function colourFor(status: SpendRequest['status']): string {
  if (status === 'SETTLED') return GREEN;
  if (status === 'DENIED') return RED;
  if (status === 'PENDING_HUMAN' || status === 'AWAITING_BUYER_APPROVAL') return YELLOW;
  return CYAN;
}

function report(label: string, req: SpendRequest): void {
  const c = colourFor(req.status);
  out();
  out(`${BOLD}${label}${RESET}`);
  rule();
  out(`  Request      ${req.id}`);
  out(`  Purchase     ${req.description}`);
  out(`  Amount       ${format(req.amountMinor, req.currency)} to ${req.merchantName}  ${DIM}(${req.category})${RESET}`);

  if (req.policy) {
    const failed = req.policy.rules.filter((r) => r.status === 'FAIL');
    const flagged = req.policy.rules.filter((r) => r.status === 'FLAG');
    const passed = req.policy.rules.length - failed.length - flagged.length;
    out(`  Stage 1      ${BOLD}policy engine: ${req.policy.decision}${RESET}  ${DIM}(${passed} passed, ${flagged.length} flagged, ${failed.length} failed)${RESET}`);
    for (const r of failed) out(`                 ${RED}FAIL${RESET} ${r.code}: ${r.detail}`);
    for (const r of flagged) out(`                 ${YELLOW}FLAG${RESET} ${r.code}: ${r.detail}`);
  }

  if (req.adjudication) {
    const a = req.adjudication;
    out(`  Stage 2      ${BOLD}AI adjudicator: ${a.decision}${RESET} ${DIM}(confidence ${a.confidence.toFixed(2)}, ${a.provider}:${a.model}, ${a.latencyMs}ms)${RESET}`);
    out(`                 ${a.rationale}`);
    if (a.riskFlags.length) out(`                 ${DIM}risk flags: ${a.riskFlags.join(', ')}${RESET}`);
    if (a.degraded) out(`                 ${YELLOW}degraded:${RESET} ${a.degraded}`);
  } else if (req.policy?.terminal) {
    out(`  Stage 2      ${DIM}AI adjudicator not consulted - the deterministic rules already denied this${RESET}`);
  }

  if (req.humanDecision) {
    out(`  Human        ${req.humanDecision.decision} by ${req.humanDecision.by}${req.humanDecision.note ? ` - "${req.humanDecision.note}"` : ''}`);
  }

  if (req.settlement) {
    const s = req.settlement;
    out(`  Settlement   ${s.rail} / ${s.status}${s.simulated ? ` ${DIM}[SIMULATED]${RESET}` : ''}`);
    if (s.paypalId) out(`                 PayPal reference: ${s.paypalId}`);
    if (s.authorizationId) out(`                 authorization: ${s.authorizationId}`);
    if (s.captureId) out(`                 capture: ${s.captureId}`);
    if (s.approvalUrl) out(`                 approval URL: ${s.approvalUrl}`);
    if (s.error) out(`                 ${RED}error:${RESET} ${s.error}`);
  }

  out(`  Outcome      ${c}${BOLD}${req.status}${RESET}`);
}

async function main(): Promise<void> {
  const reset = process.argv.includes('--reset');
  if (reset) {
    ledger().reset();
    out(`${DIM}Audit ledger reset.${RESET}`);
  }

  const p = posture();
  out();
  out(`${BOLD}Mandate - end-to-end walkthrough${RESET}`);
  rule('=');
  out(`  PayPal  ${p.paypal.mode.toUpperCase().padEnd(10)} ${DIM}${p.paypal.detail}${RESET}`);
  out(`  AI      ${p.ai.mode.toUpperCase().padEnd(10)} ${DIM}${p.ai.detail}${RESET}`);
  rule('=');

  const { mandate } = seedDemo();
  out();
  out(`${BOLD}Mandate granted${RESET}`);
  rule();
  out(`  ${mandate.id}  "${mandate.label}"`);
  out(`  Agent                ${mandate.agentName}`);
  out(`  Budget               ${format(mandate.budgetMinor, mandate.currency)}`);
  out(`  Per-transaction cap  ${format(mandate.rules.perTransactionCapMinor, mandate.currency)}`);
  out(`  Autonomous limit     ${format(mandate.rules.autoApproveLimitMinor, mandate.currency)} ${DIM}(at or above this, a human must approve)${RESET}`);
  out(`  Denied categories    ${mandate.rules.categoryDenylist.join(', ') || '(none)'}`);
  out(`  Purpose              ${mandate.rules.purpose}`);

  const agent = 'infra-ops-agent';

  // 1. Clean autonomous approval.
  const a = await requestSpend({
    mandateId: mandate.id,
    itemIds: ['nw-compute-std', 'nw-object-storage'],
    justification:
      'Ingest volume grew 40% this month. The pipeline needs one more standard compute node and another terabyte of object storage to hold the raw landing zone.',
    agentName: agent,
  });
  report('1. In-purpose and under every limit -> settles autonomously, no human involved', a);

  // 2. Escalation: the amount is at the autonomous ceiling.
  const b = await requestSpend({
    mandateId: mandate.id,
    itemIds: ['carto-enrich-50k'],
    justification:
      'The customer dimension table needs a one-off backfill of 50,000 company enrichment lookups so the attribution models stop dropping rows.',
    agentName: agent,
  });
  report('2. In-purpose but at the autonomous ceiling -> escalated to a human', b);

  // 3. AI denial: inside every hard limit, outside the mandate's purpose.
  const c = await requestSpend({
    mandateId: mandate.id,
    itemIds: ['atlas-task-chair'],
    justification: 'The new backend hire starts Monday and needs an ergonomic chair at their desk before their first day.',
    agentName: agent,
  });
  report('3. Within every hard limit, but outside the purpose -> denied by the AI adjudicator', c);

  // 4. Deterministic denial: never reaches the model.
  const d = await requestSpend({
    mandateId: mandate.id,
    itemIds: ['moonlit-gc-500'],
    justification: 'Team rewards for shipping the migration ahead of schedule. This is a routine morale expense.',
    agentName: agent,
  });
  report('4. Breaches hard rules -> denied by code, the model is never consulted', d);

  // 5. Resolve the escalation from step 2 the whole way through PayPal.
  if (b.status === 'PENDING_HUMAN') {
    const approved = await decideHuman(b.id, {
      decision: 'APPROVE',
      by: 'priya@example.com',
      note: 'Backfill is on the Q4 roadmap. Approved.',
    });
    report('5a. Human approves -> a real PayPal order is created for buyer approval', approved);

    if (approved.status === 'AWAITING_BUYER_APPROVAL') {
      if (config.paypal.live) {
        out();
        out(`${YELLOW}  Open the approval URL above, log in with your sandbox buyer account and approve.${RESET}`);
        out(`${DIM}  PayPal will redirect back and the control plane will authorize then capture automatically.${RESET}`);
      } else {
        const captured = await completeBuyerApproval(approved.id);
        report('5b. Buyer approves at PayPal -> authorization placed, then captured', captured);
      }
    }
  }

  // --- Closing state ---------------------------------------------------
  const finalMandate = getMandateOrThrow(mandate.id);
  const chain = ledger().verify();

  out();
  out(`${BOLD}Mandate position${RESET}`);
  rule();
  out(`  Budget     ${format(finalMandate.budgetMinor, finalMandate.currency)}`);
  out(`  Settled    ${format(finalMandate.spentMinor, finalMandate.currency)}`);
  out(`  Reserved   ${format(finalMandate.reservedMinor, finalMandate.currency)} ${DIM}(approved or awaiting approval, not yet captured)${RESET}`);
  out(`  Refunded   ${format(finalMandate.refundedMinor, finalMandate.currency)}`);
  out(`  Available  ${BOLD}${format(availableMinor(finalMandate), finalMandate.currency)}${RESET}`);

  out();
  out(`${BOLD}Audit chain${RESET}`);
  rule();
  out(`  ${chain.length} events, hash chain ${chain.valid ? `${GREEN}valid${RESET}` : `${RED}INVALID at seq ${chain.brokenAt?.seq}${RESET}`}`);
  out(`  Head  ${chain.headHash}`);
  out(`  File  ${ledger().filePath}`);
  out();
  out(`${DIM}  Every decision above is reconstructable from that file alone. Alter one byte of it`);
  out(`  and GET /api/ledger/verify names the exact event that was changed.${RESET}`);
  out();
}

await main();
