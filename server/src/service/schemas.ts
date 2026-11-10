import { z } from 'zod';
import { config } from '../config.ts';

/**
 * Input validation at the trust boundary.
 *
 * Everything that can create or alter financial authority is parsed here
 * first. Amounts arrive as decimal strings ("250.00") because that is what
 * both humans and the PayPal API use, and are converted to integer minor
 * units exactly once, on the way in.
 */

const decimalAmount = z
  .string()
  .trim()
  .regex(/^\d+(\.\d{1,3})?$/, 'Expected a positive decimal amount such as "250.00"');

export const MandateRulesInput = z.object({
  perTransactionCap: decimalAmount,
  autoApproveLimit: decimalAmount,
  velocity: z.object({
    windowHours: z.number().int().min(1).max(24 * 90),
    maxTransactions: z.number().int().min(1).max(10_000),
    maxAmount: decimalAmount,
  }),
  merchantAllowlist: z.array(z.string().min(1).max(64)).max(200).default([]),
  merchantDenylist: z.array(z.string().min(1).max(64)).max(200).default([]),
  categoryAllowlist: z.array(z.string().min(1).max(64)).max(200).default([]),
  categoryDenylist: z.array(z.string().min(1).max(64)).max(200).default([]),
  purpose: z.string().trim().min(10, 'A mandate purpose is required - it is what the AI adjudicator holds each spend against').max(1000),
  requireHumanForAll: z.boolean().default(false),
});

export const CreateMandateInput = z.object({
  label: z.string().trim().min(1).max(120),
  agentName: z.string().trim().min(1).max(80),
  currency: z.string().trim().length(3).default(config.currency).transform((c) => c.toUpperCase()),
  budget: decimalAmount,
  /** ISO timestamp, or a relative shorthand like "30d" / "12h". */
  expiresIn: z.string().trim().regex(/^\d+[hdw]$/, 'Expected a duration like "30d", "48h" or "2w"').default('30d'),
  rules: MandateRulesInput,
});

export const UpdateMandateInput = z.object({
  label: z.string().trim().min(1).max(120).optional(),
  budget: decimalAmount.optional(),
  rules: MandateRulesInput.partial().optional(),
});

export const RevokeMandateInput = z.object({
  reason: z.string().trim().min(1).max(500).default('Revoked by operator'),
});

export const SpendRequestInput = z.object({
  mandateId: z.string().trim().min(1).max(64),
  /** Either name the merchant directly, or let the items imply it. */
  merchantId: z.string().trim().min(1).max(64).optional(),
  itemIds: z.array(z.string().trim().min(1).max(64)).max(20).default([]),
  /** Required when no items are given (an off-catalog purchase). */
  amount: decimalAmount.optional(),
  currency: z.string().trim().length(3).optional().transform((c) => (c ? c.toUpperCase() : undefined)),
  description: z.string().trim().min(1).max(300).optional(),
  category: z.string().trim().min(1).max(64).optional(),
  justification: z.string().trim().min(1).max(2000),
  agentName: z.string().trim().min(1).max(80).default('unnamed-agent'),
});

export const HumanDecisionInput = z.object({
  decision: z.enum(['APPROVE', 'DENY']),
  by: z.string().trim().min(1).max(80).default('operator'),
  note: z.string().trim().max(1000).default(''),
});

export const RefundInput = z.object({
  amount: decimalAmount.optional(),
  reason: z.string().trim().min(1).max(255).default('Refunded by operator'),
});

export const AgentChatInput = z.object({
  mandateId: z.string().trim().min(1).max(64),
  message: z.string().trim().min(1).max(4000),
  /** Prior turns, so the console can hold a conversation. */
  history: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']),
        text: z.string().max(8000),
      }),
    )
    .max(40)
    .default([]),
});

/** "30d" / "48h" / "2w" -> milliseconds. */
export function durationToMs(spec: string): number {
  const m = /^(\d+)([hdw])$/.exec(spec);
  if (!m) throw new Error(`Invalid duration: ${spec}`);
  const n = Number(m[1]);
  const unit = m[2];
  const factor = unit === 'h' ? 3.6e6 : unit === 'd' ? 8.64e7 : 6.048e8;
  return n * factor;
}

export type CreateMandateInputT = z.infer<typeof CreateMandateInput>;
export type SpendRequestInputT = z.infer<typeof SpendRequestInput>;
export type HumanDecisionInputT = z.infer<typeof HumanDecisionInput>;
