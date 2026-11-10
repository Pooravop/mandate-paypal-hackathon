/** Domain model for the Mandate control plane. All amounts are integer minor units. */

export type SettlementRail = 'PAYOUT' | 'ORDER_AUTHORIZE';

export interface MandateRules {
  /** Hard ceiling on a single transaction. */
  perTransactionCapMinor: number;
  /** Anything at or above this needs a human, even if every other rule passes. */
  autoApproveLimitMinor: number;
  /** Rolling-window velocity guards. */
  velocity: {
    windowHours: number;
    maxTransactions: number;
    maxAmountMinor: number;
  };
  /** Empty allowlist == all merchants permitted (subject to the denylist). */
  merchantAllowlist: string[];
  merchantDenylist: string[];
  /** Empty allowlist == all categories permitted. */
  categoryAllowlist: string[];
  categoryDenylist: string[];
  /** Natural-language purpose the LLM adjudicator holds each spend against. */
  purpose: string;
  /** Require a human for every spend regardless of amount. */
  requireHumanForAll: boolean;
}

export interface Mandate {
  id: string;
  label: string;
  /** Who the mandate was granted to - the agent identity presenting it. */
  agentName: string;
  currency: string;
  budgetMinor: number;
  /** Funds committed by approved-but-unsettled requests. */
  reservedMinor: number;
  /** Funds actually settled through PayPal. */
  spentMinor: number;
  /** Funds returned by refunds / voids. */
  refundedMinor: number;
  rules: MandateRules;
  status: 'ACTIVE' | 'REVOKED' | 'EXPIRED';
  createdAt: string;
  expiresAt: string;
  revokedAt?: string;
  revokedReason?: string;
}

export type Decision = 'APPROVE' | 'ESCALATE' | 'DENY';

export interface RuleResult {
  code: string;
  title: string;
  status: 'PASS' | 'FLAG' | 'FAIL';
  detail: string;
  /** Machine-readable evidence so the UI and the LLM see identical facts. */
  evidence?: Record<string, unknown>;
}

export interface PolicyVerdict {
  decision: Decision;
  rules: RuleResult[];
  /** Short reason the deterministic layer reached this decision. */
  reason: string;
  /** True when deterministic rules alone settled it and no LLM call is warranted. */
  terminal: boolean;
  /**
   * A rule demanded a human regardless of what the AI concludes. The AI layer
   * can never clear this - it is the one-way ratchet that keeps an agreeable
   * model from approving a spend the mandate reserved for its owner.
   */
  forcesHuman: boolean;
}

export interface AdjudicationResult {
  decision: Decision;
  confidence: number;
  rationale: string;
  riskFlags: string[];
  provider: string;
  model: string;
  latencyMs: number;
  /** Set when the LLM path failed and we fell back to the conservative default. */
  degraded?: string;
}

export interface SpendRequest {
  id: string;
  mandateId: string;
  agentName: string;
  merchantId: string;
  merchantName: string;
  merchantReceiver: string;
  category: string;
  description: string;
  /** What the agent claims this purchase achieves - the adjudicator's input. */
  justification: string;
  itemRefs: string[];
  currency: string;
  amountMinor: number;
  rail: SettlementRail;
  status:
    | 'PENDING_POLICY'
    | 'PENDING_HUMAN'
    | 'APPROVED'
    | 'DENIED'
    | 'SETTLED'
    | 'SETTLEMENT_FAILED'
    | 'AWAITING_BUYER_APPROVAL'
    | 'CANCELLED'
    | 'REFUNDED';
  policy?: PolicyVerdict;
  adjudication?: AdjudicationResult;
  humanDecision?: { by: string; decision: 'APPROVE' | 'DENY'; note: string; at: string };
  settlement?: Settlement;
  createdAt: string;
  updatedAt: string;
}

export interface Settlement {
  rail: SettlementRail;
  /** Whether this hit the real PayPal API or the local simulator. */
  simulated: boolean;
  status: string;
  /** Payouts: payout_batch_id. Orders: order id. */
  paypalId?: string;
  payoutItemId?: string;
  authorizationId?: string;
  captureId?: string;
  refundId?: string;
  approvalUrl?: string;
  /** Raw PayPal response, retained verbatim for the audit trail. */
  raw?: unknown;
  error?: string;
  at: string;
}

export interface CatalogItem {
  id: string;
  name: string;
  description: string;
  category: string;
  priceMinor: number;
  currency: string;
  merchantId: string;
}

export interface Merchant {
  id: string;
  name: string;
  /** PayPal sandbox account email that receives payouts. */
  receiver: string;
  category: string;
  trustTier: 'VERIFIED' | 'STANDARD' | 'UNVERIFIED';
  about: string;
}

/** Every mutation in the system is one of these, appended to the hash chain. */
export type LedgerEventType =
  | 'MANDATE_CREATED'
  | 'MANDATE_UPDATED'
  | 'MANDATE_REVOKED'
  | 'SPEND_REQUESTED'
  | 'POLICY_EVALUATED'
  | 'AI_ADJUDICATED'
  | 'HUMAN_DECIDED'
  | 'DECISION_APPLIED'
  | 'ESCALATED'
  | 'SETTLEMENT_ATTEMPTED'
  | 'SETTLEMENT_SUCCEEDED'
  | 'SETTLEMENT_FAILED'
  | 'BUYER_APPROVAL_REQUIRED'
  | 'AUTHORIZATION_CAPTURED'
  | 'AUTHORIZATION_VOIDED'
  | 'PAYMENT_REFUNDED'
  | 'WEBHOOK_RECEIVED'
  | 'LEDGER_INITIALISED';

export interface LedgerEvent {
  /** Monotonic sequence number, starting at 1. */
  seq: number;
  id: string;
  type: LedgerEventType;
  at: string;
  /** Subject of the event: a mandate id, spend-request id, etc. */
  subject: string;
  actor: string;
  summary: string;
  data: Record<string, unknown>;
  /** sha256 of the previous event's hash; genesis uses 64 zeroes. */
  prevHash: string;
  hash: string;
}
