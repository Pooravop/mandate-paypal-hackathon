import { config } from '../config.ts';
import { createMandate } from './mandates.ts';
import { availableMinor } from '../policy/engine.ts';
import type { Mandate } from '../types.ts';

/**
 * Seeds a mandate shaped to make the control plane's behaviour visible.
 *
 * The numbers are chosen so that a reviewer poking at the catalog hits all
 * four outcomes without having to think about it:
 *
 *   $23-$155  cloud/monitoring items  -> clean APPROVE, settles autonomously
 *   $250+     e.g. company enrichment -> at the autonomous limit, needs a human
 *   $485-$749 office furniture        -> within limits, but AI denies on purpose
 *   $2,500    gift-card bundle        -> breaches the per-transaction cap outright
 */
export function seedDemo(): { mandate: Mandate & { availableMinor: number }; notes: string[] } {
  const mandate = createMandate({
    label: 'Production infrastructure - November',
    agentName: 'infra-ops-agent',
    currency: config.currency,
    budget: '2000.00',
    expiresIn: '30d',
    rules: {
      perTransactionCap: '600.00',
      autoApproveLimit: '250.00',
      velocity: { windowHours: 24, maxTransactions: 8, maxAmount: '1200.00' },
      merchantAllowlist: [],
      merchantDenylist: [],
      categoryAllowlist: [],
      categoryDenylist: ['gift-cards'],
      purpose:
        'Keep the production data pipeline running: cloud compute, managed databases, object storage, monitoring and observability, on-call paging, and data enrichment APIs that the pipeline depends on.',
      requireHumanForAll: false,
    },
  });

  return {
    mandate: { ...mandate, availableMinor: availableMinor(mandate) },
    notes: [
      'Try: "we need another compute node and tracing" -> clean approve, settles via PayPal Payouts with no human involved.',
      'Try: "buy 50k company enrichment lookups" -> $250 is at the autonomous limit, so it escalates for human approval.',
      'Try: "order a standing desk for the new hire" -> within every hard limit, but the AI adjudicator denies it as outside the mandate purpose.',
      'Try: "get the 500-unit gift card bundle" -> blocked by the deterministic rules before the AI is even consulted.',
    ],
  };
}
