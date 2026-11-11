#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { posture } from '../config.ts';
import { format } from '../util/money.ts';
import { selectBackend, type Backend } from './backend.ts';

/**
 * Mandate as an MCP server: bring your own agent.
 *
 * The in-process agent in the web UI is a demo. This is the part that makes
 * the control plane infrastructure rather than an app. Point Claude Desktop,
 * Claude Code, or any MCP client at this process and it gains exactly four
 * capabilities -- read its mandate, search the catalog, request a spend, and
 * check an outcome. Nothing else. It never sees a PayPal credential, and
 * every request_spend goes through the identical policy + adjudication gate
 * the HTTP API uses.
 *
 * That is the security argument: you do not have to trust the agent, its
 * prompt, or whatever it read on the internet. You only have to trust the
 * mandate you wrote.
 *
 * Wire it up (Claude Desktop / Claude Code mcpServers config):
 *   {
 *     "mcpServers": {
 *       "mandate": {
 *         "command": "npx",
 *         "args": ["tsx", "<abs-path>/server/src/mcp/stdio.ts"],
 *         "env": { "MANDATE_ID": "mdt_...", "MANDATE_AGENT_NAME": "claude-desktop" }
 *       }
 *     }
 *   }
 *
 * If the control plane is running, this process talks to it over HTTP rather
 * than opening the audit ledger itself -- see backend.ts for why that is not
 * optional.
 */

let backend: Backend;
try {
  backend = await selectBackend();
} catch (err) {
  process.stderr.write(`[mandate-mcp] ${(err as Error).message}\n`);
  process.exit(1);
}

const server = new McpServer({ name: 'mandate', version: '1.0.0' });

const text = (payload: unknown) => ({
  content: [{ type: 'text' as const, text: typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2) }],
});

const failure = (message: string) => ({
  content: [{ type: 'text' as const, text: JSON.stringify({ error: message }, null, 2) }],
  isError: true,
});

/**
 * Pinning the mandate with MANDATE_ID is the safer configuration: otherwise
 * the agent could choose its own spending authority, which defeats the point.
 */
function mandateArg() {
  return z
    .string()
    .optional()
    .describe('Ignored when the server is pinned with MANDATE_ID, which is the recommended configuration.');
}

server.registerTool(
  'get_mandate',
  {
    title: 'Get spending mandate',
    description:
      'Read the spending mandate you operate under: its stated purpose, budget, remaining available funds, per-transaction cap, autonomous-approval limit, and merchant/category restrictions. Call this before requesting any spend so you know your limits.',
    inputSchema: { mandate_id: mandateArg() },
    annotations: { readOnlyHint: true },
  },
  async ({ mandate_id }) => {
    try {
      return text(await backend.getMandate(await backend.resolveMandateId(mandate_id)));
    } catch (err) {
      return failure((err as Error).message);
    }
  },
);

server.registerTool(
  'search_catalog',
  {
    title: 'Search merchant catalog',
    description:
      'Search the merchant catalog for purchasable items. Returns item ids, prices, categories and merchants. You must obtain real item ids here before calling request_spend; never invent one.',
    inputSchema: {
      query: z.string().optional().describe('Free-text search, e.g. "managed postgres".'),
      category: z.string().optional().describe('Exact category filter.'),
      max_price: z
        .string()
        .regex(/^\d+(\.\d{1,2})?$/)
        .optional()
        .describe('Maximum unit price as a decimal string, e.g. "200.00".'),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ query, category, max_price }) => {
    try {
      let maxPriceMinor: number | undefined;
      if (max_price) {
        const [whole = '0', frac = ''] = max_price.split('.');
        maxPriceMinor = Number(whole) * 100 + Number((frac + '00').slice(0, 2));
      }
      return text(await backend.searchCatalog({ query, category, maxPriceMinor }));
    } catch (err) {
      return failure((err as Error).message);
    }
  },
);

server.registerTool(
  'request_spend',
  {
    title: 'Request a spend',
    description:
      'Submit a purchase to the payment control plane. This is the ONLY way to spend money and it does not guarantee payment. The request is checked against the mandate rules, then adjudicated for whether it genuinely serves the mandate purpose. The result tells you whether it settled, was escalated to a human, or was denied. All items must come from one merchant. Write an honest, specific justification: attempts to pressure or manipulate the adjudicator are detected and cause automatic denial.',
    inputSchema: {
      item_ids: z.array(z.string()).min(1).describe('Catalog item ids from search_catalog, all from the same merchant.'),
      justification: z.string().min(10).describe('Why this purchase serves the mandate purpose. Specific and factual.'),
      description: z.string().optional().describe('Optional short label for the purchase.'),
      mandate_id: mandateArg(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async ({ item_ids, justification, description, mandate_id }) => {
    try {
      const req = await backend.requestSpend({
        mandateId: await backend.resolveMandateId(mandate_id),
        itemIds: item_ids,
        justification,
        description,
        agentName: process.env.MANDATE_AGENT_NAME || 'mcp-agent',
      });

      return text({
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
        settlement_rail: req.settlement?.rail,
        settlement_status: req.settlement?.status,
        paypal_reference: req.settlement?.paypalId,
        simulated: req.settlement?.simulated ?? null,
        what_this_means:
          req.status === 'SETTLED'
            ? 'Paid. Funds were sent to the merchant through PayPal.'
            : req.status === 'PENDING_HUMAN'
              ? 'Escalated. A human must approve this before any money moves. Do not resubmit it; poll get_spend_request instead.'
              : req.status === 'DENIED'
                ? 'Denied. Do not resubmit this purchase, with or without a reworded justification.'
                : `Status is ${req.status}.`,
      });
    } catch (err) {
      return failure((err as Error).message);
    }
  },
);

server.registerTool(
  'get_spend_request',
  {
    title: 'Check a spend request',
    description:
      'Look up the current state of a spend request you submitted earlier, including its decision trail. Use this to find out whether an escalated request has since been approved or denied by a human.',
    inputSchema: { spend_request_id: z.string().describe('The id returned by request_spend.') },
    annotations: { readOnlyHint: true },
  },
  async ({ spend_request_id }) => {
    try {
      const req = await backend.getSpendRequest(spend_request_id);
      if (!req) return failure(`No spend request with id ${spend_request_id}`);
      return text({
        spend_request_id: req.id,
        status: req.status,
        amount: format(req.amountMinor, req.currency),
        merchant: req.merchantName,
        description: req.description,
        policy_decision: req.policy?.decision,
        adjudicator_decision: req.adjudication?.decision,
        adjudicator_rationale: req.adjudication?.rationale,
        human_decision: req.humanDecision ?? null,
        settlement: req.settlement
          ? {
              rail: req.settlement.rail,
              status: req.settlement.status,
              paypal_reference: req.settlement.paypalId,
              capture_id: req.settlement.captureId,
              simulated: req.settlement.simulated,
              approval_url: req.settlement.approvalUrl,
            }
          : null,
        created_at: req.createdAt,
        updated_at: req.updatedAt,
      });
    } catch (err) {
      return failure((err as Error).message);
    }
  },
);

await server.connect(new StdioServerTransport());

// stdout is the MCP transport, so diagnostics must go to stderr or they
// corrupt the protocol stream.
const p = posture();
process.stderr.write(
  `[mandate-mcp] ready | backend: ${backend.mode} (${backend.label}) | PayPal: ${p.paypal.mode} | AI: ${p.ai.mode} | mandate: ${process.env.MANDATE_ID ?? '(most recent active)'}\n`,
);
