/** Typed client for the control-plane API. */

export type Decision = 'APPROVE' | 'ESCALATE' | 'DENY';

export interface RuleResult {
  code: string;
  title: string;
  status: 'PASS' | 'FLAG' | 'FAIL';
  detail: string;
  evidence?: Record<string, unknown>;
}

export interface PolicyVerdict {
  decision: Decision;
  rules: RuleResult[];
  reason: string;
  terminal: boolean;
  forcesHuman: boolean;
}

export interface Adjudication {
  decision: Decision;
  confidence: number;
  rationale: string;
  riskFlags: string[];
  provider: string;
  model: string;
  latencyMs: number;
  degraded?: string;
}

export interface Settlement {
  rail: 'PAYOUT' | 'ORDER_AUTHORIZE';
  simulated: boolean;
  status: string;
  paypalId?: string;
  payoutItemId?: string;
  authorizationId?: string;
  captureId?: string;
  refundId?: string;
  approvalUrl?: string;
  error?: string;
  at: string;
}

export type RequestStatus =
  | 'PENDING_POLICY'
  | 'PENDING_HUMAN'
  | 'APPROVED'
  | 'DENIED'
  | 'SETTLED'
  | 'SETTLEMENT_FAILED'
  | 'AWAITING_BUYER_APPROVAL'
  | 'CANCELLED'
  | 'REFUNDED';

export interface SpendRequest {
  id: string;
  mandateId: string;
  agentName: string;
  merchantId: string;
  merchantName: string;
  merchantReceiver: string;
  category: string;
  description: string;
  justification: string;
  itemRefs: string[];
  currency: string;
  amountMinor: number;
  rail: 'PAYOUT' | 'ORDER_AUTHORIZE';
  status: RequestStatus;
  policy?: PolicyVerdict;
  adjudication?: Adjudication;
  humanDecision?: { by: string; decision: 'APPROVE' | 'DENY'; note: string; at: string };
  settlement?: Settlement;
  createdAt: string;
  updatedAt: string;
}

export interface Mandate {
  id: string;
  label: string;
  agentName: string;
  currency: string;
  budgetMinor: number;
  reservedMinor: number;
  spentMinor: number;
  refundedMinor: number;
  availableMinor: number;
  status: 'ACTIVE' | 'REVOKED' | 'EXPIRED';
  createdAt: string;
  expiresAt: string;
  revokedAt?: string;
  revokedReason?: string;
  rules: {
    perTransactionCapMinor: number;
    autoApproveLimitMinor: number;
    velocity: { windowHours: number; maxTransactions: number; maxAmountMinor: number };
    merchantAllowlist: string[];
    merchantDenylist: string[];
    categoryAllowlist: string[];
    categoryDenylist: string[];
    purpose: string;
    requireHumanForAll: boolean;
  };
}

export interface LedgerEvent {
  seq: number;
  id: string;
  type: string;
  at: string;
  subject: string;
  actor: string;
  summary: string;
  data: Record<string, unknown>;
  prevHash: string;
  hash: string;
}

export interface Posture {
  paypal: { mode: string; env: string; detail: string };
  ai: { mode: string; provider: string; model: string; detail: string };
}

export interface AppConfig {
  posture: Posture;
  paypal: {
    env: string;
    baseUrl: string;
    live: boolean;
    webhookConfigured: boolean;
    receiverIsPlaceholder: boolean;
    scopes: string[];
    credentialError?: string;
  };
  ai: { provider: string; label: string };
  currency: string;
  categories: string[];
  merchants: Array<{ id: string; name: string; receiver: string; category: string; trustTier: string; about: string }>;
  operatorTokenRequired: boolean;
  publicUrl: string;
}

export interface CatalogItem {
  id: string;
  name: string;
  description: string;
  category: string;
  priceMinor: number;
  currency: string;
  merchantId: string;
  merchantName: string;
  merchantTrustTier: string;
}

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/** Operator token, if the deployment requires one. Held in memory only. */
let operatorToken = '';
export function setOperatorToken(token: string): void {
  operatorToken = token;
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = { ...(init?.headers as Record<string, string>) };
  if (init?.body) headers['Content-Type'] = 'application/json';
  if (operatorToken) headers['Authorization'] = `Bearer ${operatorToken}`;

  const res = await fetch(`/api${path}`, { ...init, headers });
  const text = await res.text();
  const body = text ? JSON.parse(text) : {};

  if (!res.ok) {
    throw new ApiError(res.status, body.error ?? 'UNKNOWN', body.message ?? `Request failed with HTTP ${res.status}`);
  }
  return body as T;
}

export const api = {
  config: () => call<AppConfig>('/config'),
  health: () => call<{ ok: boolean; ledgerEvents: number; ledgerValid: boolean }>('/health'),

  mandates: () => call<{ mandates: Mandate[] }>('/mandates'),
  mandate: (id: string) => call<{ mandate: Mandate; requests: SpendRequest[] }>(`/mandates/${id}`),
  createMandate: (body: unknown) => call<{ mandate: Mandate }>('/mandates', { method: 'POST', body: JSON.stringify(body) }),
  revokeMandate: (id: string, reason: string) =>
    call<{ mandate: Mandate }>(`/mandates/${id}/revoke`, { method: 'POST', body: JSON.stringify({ reason }) }),

  requests: (params: { mandateId?: string; status?: string } = {}) => {
    const q = new URLSearchParams();
    if (params.mandateId) q.set('mandateId', params.mandateId);
    if (params.status) q.set('status', params.status);
    const suffix = q.toString() ? `?${q}` : '';
    return call<{ requests: SpendRequest[] }>(`/requests${suffix}`);
  },
  request: (id: string) => call<{ request: SpendRequest; events: LedgerEvent[] }>(`/requests/${id}`),
  submitSpend: (body: unknown) => call<{ request: SpendRequest }>('/requests', { method: 'POST', body: JSON.stringify(body) }),
  decide: (id: string, decision: 'APPROVE' | 'DENY', by: string, note: string) =>
    call<{ request: SpendRequest }>(`/requests/${id}/decision`, {
      method: 'POST',
      body: JSON.stringify({ decision, by, note }),
    }),
  refund: (id: string, reason: string) =>
    call<{ request: SpendRequest }>(`/requests/${id}/refund`, { method: 'POST', body: JSON.stringify({ reason }) }),

  ledger: (limit = 250) => call<{ events: LedgerEvent[]; total: number; head: string; file: string }>(`/ledger?limit=${limit}`),
  verifyLedger: () =>
    call<{ valid: boolean; length: number; headHash: string; brokenAt?: { seq: number; reason: string } }>('/ledger/verify'),
  resetLedger: () => call<{ ok: boolean }>('/ledger/reset', { method: 'POST' }),

  catalog: () => call<{ items: CatalogItem[] }>('/catalog'),
  seedDemo: () => call<{ mandate: Mandate; notes: string[] }>('/demo/seed', { method: 'POST' }),
};

/** Subscribes to the ledger event stream. Returns an unsubscribe function. */
export function subscribeToEvents(onEvent: (e: LedgerEvent) => void, onReset?: () => void): () => void {
  const source = new EventSource('/api/events');
  source.addEventListener('ledger', (ev) => {
    try {
      onEvent(JSON.parse((ev as MessageEvent).data) as LedgerEvent);
    } catch {
      /* ignore a malformed frame rather than tearing down the stream */
    }
  });
  if (onReset) source.addEventListener('reset', () => onReset());
  return () => source.close();
}

export interface AgentStep {
  type: 'assistant_text' | 'tool_call' | 'tool_result' | 'final' | 'error';
  text?: string;
  tool?: string;
  input?: Record<string, unknown>;
  output?: string;
  spendRequest?: SpendRequest;
}

/**
 * Streams an agent turn. The endpoint is POST + SSE rather than EventSource
 * because the request carries a body, so the frames are parsed by hand.
 */
export async function streamAgent(
  body: { mandateId: string; message: string; history: Array<{ role: 'user' | 'assistant'; text: string }> },
  handlers: {
    onStep: (step: AgentStep) => void;
    onDone: (payload: { reply: string; provider: string; model: string; spendRequestIds: string[] }) => void;
    onError: (message: string) => void;
  },
  signal?: AbortSignal,
): Promise<void> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (operatorToken) headers['Authorization'] = `Bearer ${operatorToken}`;

  const res = await fetch('/api/agent/chat', { method: 'POST', headers, body: JSON.stringify(body), signal });

  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '');
    let message = `Agent request failed with HTTP ${res.status}`;
    try {
      message = JSON.parse(text).message ?? message;
    } catch {
      /* keep the generic message */
    }
    handlers.onError(message);
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // SSE frames are separated by a blank line.
    let split: number;
    while ((split = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);

      let eventName = 'message';
      const dataLines: string[] = [];
      for (const line of frame.split('\n')) {
        if (line.startsWith('event:')) eventName = line.slice(6).trim();
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
      }
      if (dataLines.length === 0) continue;

      try {
        const payload = JSON.parse(dataLines.join('\n'));
        if (eventName === 'step') handlers.onStep(payload as AgentStep);
        else if (eventName === 'done') handlers.onDone(payload);
        else if (eventName === 'error') handlers.onError(payload.message ?? 'The agent reported an error.');
      } catch {
        /* skip an unparseable frame */
      }
    }
  }
}
