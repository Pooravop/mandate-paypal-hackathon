import { config } from '../config.ts';
import { ledger } from '../ledger/ledger.ts';
import { search } from '../catalog.ts';
import { availableMinor } from '../policy/engine.ts';
import { format } from '../util/money.ts';
import { getMandateOrThrow, listMandates } from '../service/mandates.ts';
import { requestSpend } from '../service/spend.ts';
import type { Mandate, SpendRequest } from '../types.ts';

/**
 * How the MCP server reaches the control plane.
 *
 * There are two modes, and picking between them automatically matters more
 * than it looks:
 *
 *  - **remote**: speak HTTP to a running control plane. This is the normal
 *    case. If `npm run dev` is up, the API server already owns the audit
 *    ledger, and a hash chain has exactly one valid writer -- so the MCP
 *    process must not open the log itself. It would be refused by the
 *    single-writer lock, which would make "point your own agent at it"
 *    mysteriously fail precisely when the app is running.
 *
 *  - **embedded**: no control plane is reachable, so run the pipeline
 *    in-process against the local ledger. Useful for pointing Claude Desktop
 *    at the repo with nothing else started.
 *
 * Either way the agent gets the same four capabilities and no credentials,
 * and every spend goes through the identical policy + adjudication gate.
 */

export interface Backend {
  readonly mode: 'remote' | 'embedded';
  readonly label: string;
  getMandate(mandateId: string): Promise<MandateView>;
  searchCatalog(args: { query?: string; category?: string; maxPriceMinor?: number }): Promise<CatalogView>;
  requestSpend(args: { mandateId: string; itemIds: string[]; justification: string; description?: string; agentName: string }): Promise<SpendRequest>;
  getSpendRequest(id: string): Promise<SpendRequest | undefined>;
  resolveMandateId(explicit?: string): Promise<string>;
}

export interface MandateView {
  mandate_id: string;
  label: string;
  status: string;
  purpose: string;
  currency: string;
  total_budget: string;
  available: string;
  spent: string;
  reserved_pending_approval: string;
  per_transaction_cap: string;
  autonomous_approval_limit: string;
  limits_note: string;
  merchant_allowlist: string[] | string;
  merchant_denylist: string[];
  category_allowlist: string[] | string;
  category_denylist: string[];
  expires_at: string;
  velocity: { window_hours: number; max_transactions: number; max_amount: string };
}

export interface CatalogView {
  result_count: number;
  items: Array<{
    item_id: string;
    name: string;
    description: string;
    price: string;
    category: string;
    merchant_id: string;
    merchant: string;
    merchant_trust: string;
  }>;
}

function viewMandate(m: Mandate): MandateView {
  return {
    mandate_id: m.id,
    label: m.label,
    status: m.status,
    purpose: m.rules.purpose,
    currency: m.currency,
    total_budget: format(m.budgetMinor, m.currency),
    available: format(availableMinor(m), m.currency),
    spent: format(m.spentMinor, m.currency),
    reserved_pending_approval: format(m.reservedMinor, m.currency),
    per_transaction_cap: format(m.rules.perTransactionCapMinor, m.currency),
    autonomous_approval_limit: format(m.rules.autoApproveLimitMinor, m.currency),
    limits_note: `Any spend at or above ${format(m.rules.autoApproveLimitMinor, m.currency)} requires a human to approve it, however well justified.`,
    merchant_allowlist: m.rules.merchantAllowlist.length ? m.rules.merchantAllowlist : 'all merchants permitted',
    merchant_denylist: m.rules.merchantDenylist,
    category_allowlist: m.rules.categoryAllowlist.length ? m.rules.categoryAllowlist : 'all categories permitted',
    category_denylist: m.rules.categoryDenylist,
    expires_at: m.expiresAt,
    velocity: {
      window_hours: m.rules.velocity.windowHours,
      max_transactions: m.rules.velocity.maxTransactions,
      max_amount: format(m.rules.velocity.maxAmountMinor, m.currency),
    },
  };
}

function pinnedId(explicit?: string): string | undefined {
  return process.env.MANDATE_ID || explicit;
}

// --- Remote (HTTP) -------------------------------------------------------

class RemoteBackend implements Backend {
  readonly mode = 'remote' as const;
  readonly label: string;
  private readonly base: string;
  private readonly token: string;

  constructor(base: string) {
    this.base = base.replace(/\/$/, '');
    this.token = process.env.OPERATOR_TOKEN ?? '';
    this.label = `remote control plane at ${this.base}`;
  }

  private async call<T>(path: string, init?: RequestInit): Promise<T> {
    const headers: Record<string, string> = { Accept: 'application/json', ...(init?.headers as Record<string, string>) };
    if (init?.body) headers['Content-Type'] = 'application/json';
    if (this.token) headers['Authorization'] = `Bearer ${this.token}`;

    const res = await fetch(`${this.base}/api${path}`, { ...init, headers, signal: AbortSignal.timeout(60_000) });
    const text = await res.text();
    const body = text ? JSON.parse(text) : {};
    if (!res.ok) throw new Error(body.message ?? `Control plane returned HTTP ${res.status}`);
    return body as T;
  }

  async resolveMandateId(explicit?: string): Promise<string> {
    const pinned = pinnedId(explicit);
    if (pinned) return pinned;
    const { mandates } = await this.call<{ mandates: Mandate[] }>('/mandates');
    const active = mandates.find((m) => m.status === 'ACTIVE');
    if (!active) throw new Error('No mandate is available. Set MANDATE_ID, or seed one with POST /api/demo/seed.');
    return active.id;
  }

  async getMandate(mandateId: string): Promise<MandateView> {
    const { mandate } = await this.call<{ mandate: Mandate }>(`/mandates/${encodeURIComponent(mandateId)}`);
    return viewMandate(mandate);
  }

  async searchCatalog(args: { query?: string; category?: string; maxPriceMinor?: number }): Promise<CatalogView> {
    const q = new URLSearchParams();
    if (args.query) q.set('query', args.query);
    if (args.category) q.set('category', args.category);
    const { items } = await this.call<{ items: Array<Record<string, any>> }>(`/catalog${q.toString() ? `?${q}` : ''}`);
    const filtered = items
      .filter((i) => (args.maxPriceMinor === undefined ? true : i.priceMinor <= args.maxPriceMinor))
      .slice(0, 15);
    return {
      result_count: filtered.length,
      items: filtered.map((h) => ({
        item_id: h.id,
        name: h.name,
        description: h.description,
        price: format(h.priceMinor, h.currency),
        category: h.category,
        merchant_id: h.merchantId,
        merchant: h.merchantName,
        merchant_trust: h.merchantTrustTier,
      })),
    };
  }

  async requestSpend(args: {
    mandateId: string;
    itemIds: string[];
    justification: string;
    description?: string;
    agentName: string;
  }): Promise<SpendRequest> {
    const { request } = await this.call<{ request: SpendRequest }>('/requests', {
      method: 'POST',
      body: JSON.stringify({
        mandateId: args.mandateId,
        itemIds: args.itemIds,
        justification: args.justification,
        description: args.description,
        agentName: args.agentName,
      }),
    });
    return request;
  }

  async getSpendRequest(id: string): Promise<SpendRequest | undefined> {
    try {
      const { request } = await this.call<{ request: SpendRequest }>(`/requests/${encodeURIComponent(id)}`);
      return request;
    } catch {
      return undefined;
    }
  }
}

// --- Embedded (in-process) ----------------------------------------------

class EmbeddedBackend implements Backend {
  readonly mode = 'embedded' as const;
  readonly label: string;

  constructor() {
    this.label = `embedded pipeline, ledger at ${ledger().filePath}`;
  }

  async resolveMandateId(explicit?: string): Promise<string> {
    const pinned = pinnedId(explicit);
    if (pinned) return pinned;
    const active = listMandates().find((m) => m.status === 'ACTIVE');
    if (!active) {
      throw new Error('No mandate is available. Set MANDATE_ID, or create one by running the control plane and seeding the demo mandate.');
    }
    return active.id;
  }

  async getMandate(mandateId: string): Promise<MandateView> {
    return viewMandate(getMandateOrThrow(mandateId));
  }

  async searchCatalog(args: { query?: string; category?: string; maxPriceMinor?: number }): Promise<CatalogView> {
    const hits = search({ ...args, limit: 15 });
    return {
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
    };
  }

  async requestSpend(args: {
    mandateId: string;
    itemIds: string[];
    justification: string;
    description?: string;
    agentName: string;
  }): Promise<SpendRequest> {
    return requestSpend(args);
  }

  async getSpendRequest(id: string): Promise<SpendRequest | undefined> {
    return ledger().getRequest(id);
  }
}

/**
 * Prefer a running control plane; fall back to in-process.
 *
 * The probe is deliberately short: this runs at MCP startup and an MCP client
 * will not wait long for a server to come up.
 */
export async function selectBackend(): Promise<Backend> {
  const explicit = process.env.MANDATE_API_URL;
  const candidates = explicit ? [explicit] : [config.publicUrl, `http://localhost:${config.port}`];

  for (const base of candidates) {
    try {
      const res = await fetch(`${base.replace(/\/$/, '')}/api/health`, { signal: AbortSignal.timeout(1500) });
      if (res.ok) return new RemoteBackend(base);
    } catch {
      /* try the next candidate */
    }
  }

  if (explicit) {
    throw new Error(`MANDATE_API_URL is set to ${explicit} but no control plane answered there. Start it with "npm run dev", or unset the variable to run the pipeline in-process.`);
  }
  return new EmbeddedBackend();
}
