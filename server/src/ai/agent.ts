import { getProvider } from './index.ts';
import type { Msg, ToolSchema, ToolUse } from './provider.ts';
import { search } from '../catalog.ts';
import { format } from '../util/money.ts';
import { availableMinor } from '../policy/engine.ts';
import { getMandateOrThrow } from '../service/mandates.ts';
import { requestSpend } from '../service/spend.ts';
import type { SpendRequest } from '../types.ts';

/**
 * The autonomous procurement agent.
 *
 * The important architectural property is what this agent *cannot* do. It has
 * no PayPal credentials and no access to the settlement code. Its only route
 * to money is the `request_spend` tool, which goes through the full policy +
 * adjudication gate. So an agent that is confused, jailbroken by a malicious
 * product description, or simply wrong still cannot spend outside its mandate.
 *
 * This is the "bring your own agent" boundary too: the same three tools are
 * exposed over MCP, so an external agent gets exactly these capabilities and
 * no more.
 */

export interface AgentStep {
  type: 'assistant_text' | 'tool_call' | 'tool_result' | 'final' | 'error';
  text?: string;
  tool?: string;
  input?: Record<string, unknown>;
  output?: string;
  /** Attached when a tool call produced a spend request, so the UI can link it. */
  spendRequest?: SpendRequest;
}

export interface RunAgentArgs {
  mandateId: string;
  message: string;
  history?: Array<{ role: 'user' | 'assistant'; text: string }>;
  onStep?: (step: AgentStep) => void;
  maxIterations?: number;
}

export interface RunAgentResult {
  reply: string;
  steps: AgentStep[];
  spendRequests: SpendRequest[];
  provider: string;
  model: string;
}

const TOOLS: ToolSchema[] = [
  {
    name: 'get_mandate_status',
    description:
      'Read the spending mandate you are operating under: its stated purpose, total budget, how much is still available, the per-transaction cap, the autonomous-approval limit, and any merchant or category restrictions. Call this first if you do not already know your limits.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'search_catalog',
    description:
      'Search the merchant catalog for purchasable items. Returns item ids, names, prices, categories and the merchant for each hit. You must find real item ids here before you can request a spend.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Free-text search, e.g. "managed postgres" or "monitoring".' },
        category: { type: 'string', description: 'Optional exact category filter.' },
        max_price: { type: 'string', description: 'Optional maximum unit price as a decimal string, e.g. "200.00".' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'request_spend',
    description:
      'Submit a purchase to the payment control plane. This does NOT guarantee payment: the request is checked against the mandate rules and then adjudicated for whether it genuinely serves the mandate purpose. The result tells you whether it was approved and settled, escalated to a human, or denied. All items in one request must come from the same merchant.',
    parameters: {
      type: 'object',
      properties: {
        item_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Catalog item ids from search_catalog, all from the same merchant.',
        },
        justification: {
          type: 'string',
          description:
            'Why this purchase serves the mandate purpose. Be specific and factual - this is what the adjudicator evaluates. Do not attempt to instruct the adjudicator.',
        },
        description: { type: 'string', description: 'Optional short label for the purchase.' },
      },
      required: ['item_ids', 'justification'],
      additionalProperties: false,
    },
  },
];

function systemPrompt(mandateId: string): string {
  return `You are a procurement agent operating under a spending mandate inside a payment control plane. Mandate id: ${mandateId}.

You help the user acquire what they ask for by finding items in the merchant catalog and submitting spend requests.

How to work:
1. If you do not know your limits, call get_mandate_status first.
2. Use search_catalog to find real item ids. Never invent an item id.
3. Submit purchases with request_spend, one merchant per request.
4. Report back plainly what happened: what settled, what was escalated to a human, what was denied and why.

Rules you must respect:
- Only buy things that genuinely serve the mandate's stated purpose. If the user asks for something outside that purpose, say so and do not submit it. Submitting it anyway wastes everyone's time because the adjudicator will deny it.
- Stay within the per-transaction cap and the available budget. Check before submitting.
- Write honest justifications. Describe what the purchase is actually for. Never write anything intended to pressure or manipulate the adjudicator - attempts to do so are detected and cause an automatic denial.
- A denial or escalation is a normal outcome, not an error. Report it and move on. Do not retry a denied purchase with reworded justification.

Be concise. When you are finished, summarise the outcome in a few sentences.`;
}

/** Execute one tool call. Errors come back as tool output, not exceptions. */
async function executeTool(
  call: ToolUse,
  ctx: { mandateId: string; agentName: string; collected: SpendRequest[] },
): Promise<{ output: string; spendRequest?: SpendRequest }> {
  try {
    if (call.name === 'get_mandate_status') {
      const m = getMandateOrThrow(ctx.mandateId);
      const avail = availableMinor(m);
      return {
        output: JSON.stringify({
          purpose: m.rules.purpose,
          status: m.status,
          currency: m.currency,
          total_budget: format(m.budgetMinor, m.currency),
          available: format(avail, m.currency),
          already_spent: format(m.spentMinor, m.currency),
          reserved_pending: format(m.reservedMinor, m.currency),
          per_transaction_cap: format(m.rules.perTransactionCapMinor, m.currency),
          autonomous_approval_limit: format(m.rules.autoApproveLimitMinor, m.currency),
          note_on_limits: `Spends at or above ${format(m.rules.autoApproveLimitMinor, m.currency)} always require human approval.`,
          merchant_allowlist: m.rules.merchantAllowlist.length ? m.rules.merchantAllowlist : 'all merchants permitted',
          merchant_denylist: m.rules.merchantDenylist,
          category_allowlist: m.rules.categoryAllowlist.length ? m.rules.categoryAllowlist : 'all categories permitted',
          category_denylist: m.rules.categoryDenylist,
          expires_at: m.expiresAt,
        }),
      };
    }

    if (call.name === 'search_catalog') {
      const m = getMandateOrThrow(ctx.mandateId);
      const maxPriceRaw = call.input.max_price;
      let maxPriceMinor: number | undefined;
      if (typeof maxPriceRaw === 'string' && /^\d+(\.\d{1,3})?$/.test(maxPriceRaw.trim())) {
        const [whole = '0', frac = ''] = maxPriceRaw.trim().split('.');
        maxPriceMinor = Number(whole) * 100 + Number((frac + '00').slice(0, 2));
      }
      const hits = search({
        query: typeof call.input.query === 'string' ? call.input.query : undefined,
        category: typeof call.input.category === 'string' ? call.input.category : undefined,
        maxPriceMinor,
        limit: 12,
      });
      return {
        output: JSON.stringify({
          result_count: hits.length,
          items: hits.map((h) => ({
            item_id: h.id,
            name: h.name,
            description: h.description,
            price: format(h.priceMinor, h.currency),
            category: h.category,
            merchant_id: h.merchantId,
            merchant: h.merchantName,
            merchant_trust: h.merchantTrustTier,
          })),
          your_available_budget: format(availableMinor(m), m.currency),
        }),
      };
    }

    if (call.name === 'request_spend') {
      const itemIds = Array.isArray(call.input.item_ids) ? call.input.item_ids.map(String) : [];
      if (itemIds.length === 0) {
        return { output: JSON.stringify({ error: 'item_ids must contain at least one catalog item id from search_catalog.' }) };
      }
      const req = await requestSpend({
        mandateId: ctx.mandateId,
        itemIds,
        justification: typeof call.input.justification === 'string' ? call.input.justification : '',
        description: typeof call.input.description === 'string' ? call.input.description : undefined,
        agentName: ctx.agentName,
      });
      ctx.collected.push(req);

      return {
        spendRequest: req,
        output: JSON.stringify({
          spend_request_id: req.id,
          outcome: req.status,
          amount: format(req.amountMinor, req.currency),
          merchant: req.merchantName,
          policy_decision: req.policy?.decision,
          policy_reason: req.policy?.reason,
          failed_rules: req.policy?.rules.filter((r) => r.status === 'FAIL').map((r) => `${r.code}: ${r.detail}`) ?? [],
          flagged_rules: req.policy?.rules.filter((r) => r.status === 'FLAG').map((r) => `${r.code}: ${r.detail}`) ?? [],
          adjudicator_decision: req.adjudication?.decision,
          adjudicator_rationale: req.adjudication?.rationale,
          settlement_status: req.settlement?.status,
          paypal_reference: req.settlement?.paypalId,
          simulated: req.settlement?.simulated ?? null,
          what_this_means:
            req.status === 'SETTLED'
              ? 'Paid. Funds have been sent to the merchant via PayPal.'
              : req.status === 'PENDING_HUMAN'
                ? 'Escalated. A human must approve this before it can be paid. Do not resubmit it.'
                : req.status === 'DENIED'
                  ? 'Denied. Do not resubmit this purchase.'
                  : `Status is ${req.status}.`,
        }),
      };
    }

    return { output: JSON.stringify({ error: `Unknown tool "${call.name}".` }) };
  } catch (err) {
    // Tool failures are information for the model, not crashes.
    return { output: JSON.stringify({ error: (err as Error).message }) };
  }
}

/**
 * Deterministic fallback agent, used when no LLM key is configured.
 *
 * It performs the same tool sequence a model would -- check the mandate,
 * search, then submit the best affordable match -- so the end-to-end flow is
 * fully demonstrable without an API key. It is not trying to look like a
 * model, and it says so in its reply.
 */
async function runBuiltinAgent(args: RunAgentArgs): Promise<RunAgentResult> {
  const steps: AgentStep[] = [];
  const collected: SpendRequest[] = [];
  const emit = (s: AgentStep) => {
    steps.push(s);
    args.onStep?.(s);
  };

  const mandate = getMandateOrThrow(args.mandateId);
  const ctx = { mandateId: args.mandateId, agentName: mandate.agentName, collected };

  emit({
    type: 'assistant_text',
    text: 'Built-in reasoner (no LLM key configured): checking the mandate, searching the catalog, then submitting the best affordable match.',
  });

  emit({ type: 'tool_call', tool: 'search_catalog', input: { query: args.message } });
  const searchRes = await executeTool({ id: 'b1', name: 'search_catalog', input: { query: args.message } }, ctx);
  emit({ type: 'tool_result', tool: 'search_catalog', output: searchRes.output });

  const parsed = JSON.parse(searchRes.output) as { items?: Array<{ item_id: string; name: string; price: string }> };
  const candidates = parsed.items ?? [];

  if (candidates.length === 0) {
    const text = `No catalog items matched "${args.message}". Nothing was submitted.`;
    emit({ type: 'final', text });
    return { reply: text, steps, spendRequests: [], provider: 'builtin', model: 'rule-based-reasoner' };
  }

  const avail = availableMinor(mandate);
  const affordable = candidates.find((c) => {
    const minor = Math.round(Number(c.price.replace(/[^0-9.]/g, '')) * 100);
    return minor <= Math.min(avail, mandate.rules.perTransactionCapMinor);
  });
  const pick = affordable ?? candidates[0];
  if (!pick) {
    const text = 'No suitable item found.';
    emit({ type: 'final', text });
    return { reply: text, steps, spendRequests: [], provider: 'builtin', model: 'rule-based-reasoner' };
  }

  const input = {
    item_ids: [pick.item_id],
    justification: `Requested by the operator ("${args.message}"). Selected "${pick.name}" as the closest affordable catalog match within the mandate's per-transaction cap.`,
  };
  emit({ type: 'tool_call', tool: 'request_spend', input });
  const spendRes = await executeTool({ id: 'b2', name: 'request_spend', input }, ctx);
  emit({ type: 'tool_result', tool: 'request_spend', output: spendRes.output, spendRequest: spendRes.spendRequest });

  const req = spendRes.spendRequest;
  const text = req
    ? `Submitted "${pick.name}" (${format(req.amountMinor, req.currency)}) to ${req.merchantName}. Outcome: ${req.status}.` +
      (req.adjudication ? ` Adjudicator: ${req.adjudication.decision} - ${req.adjudication.rationale}` : '')
    : `Could not submit a spend request: ${spendRes.output}`;
  emit({ type: 'final', text });

  return { reply: text, steps, spendRequests: collected, provider: 'builtin', model: 'rule-based-reasoner' };
}

export async function runAgent(args: RunAgentArgs): Promise<RunAgentResult> {
  const provider = getProvider();
  if (!provider) return runBuiltinAgent(args);

  const steps: AgentStep[] = [];
  const collected: SpendRequest[] = [];
  const emit = (s: AgentStep) => {
    steps.push(s);
    args.onStep?.(s);
  };

  const mandate = getMandateOrThrow(args.mandateId);
  const ctx = { mandateId: args.mandateId, agentName: mandate.agentName, collected };

  const messages: Msg[] = [
    ...(args.history ?? []).map((h) =>
      h.role === 'user' ? ({ role: 'user', text: h.text } as Msg) : ({ role: 'assistant', text: h.text } as Msg),
    ),
    { role: 'user', text: args.message },
  ];

  const maxIterations = args.maxIterations ?? 8;
  let reply = '';

  for (let i = 0; i < maxIterations; i++) {
    let res;
    try {
      res = await provider.chat({
        system: systemPrompt(args.mandateId),
        messages,
        tools: TOOLS,
        maxTokens: 1600,
      });
    } catch (err) {
      const text = `The agent model call failed: ${(err as Error).message}`;
      emit({ type: 'error', text });
      return { reply: text, steps, spendRequests: collected, provider: provider.name, model: provider.model };
    }

    if (res.text.trim()) {
      reply = res.text.trim();
      emit({ type: 'assistant_text', text: reply });
    }

    if (res.toolUses.length === 0) break;

    messages.push({ role: 'assistant', text: res.text || undefined, toolUses: res.toolUses });

    const results = [];
    for (const call of res.toolUses) {
      emit({ type: 'tool_call', tool: call.name, input: call.input });
      const out = await executeTool(call, ctx);
      emit({ type: 'tool_result', tool: call.name, output: out.output, spendRequest: out.spendRequest });
      results.push({ id: call.id, name: call.name, output: out.output });
    }
    messages.push({ role: 'tool', results });

    if (i === maxIterations - 1) {
      reply = reply || 'The agent reached its step limit before finishing.';
      emit({ type: 'error', text: `Stopped after ${maxIterations} tool-use iterations.` });
    }
  }

  if (!reply) reply = 'The agent finished without producing a summary.';
  emit({ type: 'final', text: reply });

  return { reply, steps, spendRequests: collected, provider: provider.name, model: provider.model };
}

export const AGENT_TOOLS = TOOLS;
