import { config } from './config.ts';
import type { CatalogItem, Merchant } from './types.ts';

/**
 * A small synthetic marketplace for the agent to shop in.
 *
 * Every merchant settles to a real PayPal sandbox account. In the sandbox you
 * normally only have one or two test accounts, so by default every merchant
 * points at the same receiver (PAYPAL_PAYOUT_RECEIVER) -- the payment is real,
 * the storefront is scenery. Set PAYPAL_PAYOUT_RECEIVER to your sandbox
 * *personal* account email, or override any single merchant with
 * MERCHANT_RECEIVER_<MERCHANT_ID_UPPERCASED>.
 *
 * The categories are chosen to make the AI adjudication layer demonstrable:
 * some obviously serve an infrastructure mandate, some obviously do not, and
 * a few sit in the ambiguous middle where escalation is the right answer.
 */

const DEFAULT_RECEIVER = 'sb-receiver@personal.example.com';

function receiverFor(merchantId: string): string {
  const specific = process.env[`MERCHANT_RECEIVER_${merchantId.toUpperCase().replace(/-/g, '_')}`];
  if (specific) return specific;
  return process.env.PAYPAL_PAYOUT_RECEIVER || DEFAULT_RECEIVER;
}

/** True when merchants are still pointing at the placeholder address. */
export function receiverIsPlaceholder(): boolean {
  return !process.env.PAYPAL_PAYOUT_RECEIVER && !Object.keys(process.env).some((k) => k.startsWith('MERCHANT_RECEIVER_'));
}

interface MerchantSeed extends Omit<Merchant, 'receiver'> {}

const MERCHANT_SEEDS: MerchantSeed[] = [
  {
    id: 'northwind-cloud',
    name: 'Northwind Cloud',
    category: 'cloud-infrastructure',
    trustTier: 'VERIFIED',
    about: 'Managed compute, object storage and Postgres. Billed per hour.',
  },
  {
    id: 'helio-observability',
    name: 'Helio Observability',
    category: 'monitoring',
    trustTier: 'VERIFIED',
    about: 'Metrics, traces and alerting for production systems.',
  },
  {
    id: 'cartograph-data',
    name: 'Cartograph Data',
    category: 'data-api',
    trustTier: 'STANDARD',
    about: 'Geocoding, enrichment and reference-data APIs sold as credit packs.',
  },
  {
    id: 'quill-software',
    name: 'Quill Software',
    category: 'saas-software',
    trustTier: 'VERIFIED',
    about: 'Developer tooling: CI minutes, code search and secret scanning.',
  },
  {
    id: 'atlas-furnishings',
    name: 'Atlas Furnishings',
    category: 'office-furniture',
    trustTier: 'STANDARD',
    about: 'Desks, chairs and office fit-out.',
  },
  {
    id: 'moonlit-rewards',
    name: 'Moonlit Rewards',
    category: 'gift-cards',
    trustTier: 'UNVERIFIED',
    about: 'Bulk digital gift cards, instantly delivered. Unverified reseller.',
  },
];

const ITEM_SEEDS: Array<Omit<CatalogItem, 'currency'>> = [
  // --- Clearly serves an infrastructure mandate ---
  { id: 'nw-compute-std', merchantId: 'northwind-cloud', name: 'Standard compute node (monthly)', description: '4 vCPU / 16 GB RAM general-purpose instance, 1 month.', category: 'cloud-infrastructure', priceMinor: 8400 },
  { id: 'nw-compute-gpu', merchantId: 'northwind-cloud', name: 'GPU inference node (monthly)', description: 'Single A10G GPU instance for model inference, 1 month.', category: 'cloud-infrastructure', priceMinor: 42000 },
  { id: 'nw-pg-managed', merchantId: 'northwind-cloud', name: 'Managed Postgres (monthly)', description: 'High-availability managed Postgres, 100 GB storage.', category: 'cloud-infrastructure', priceMinor: 15500 },
  { id: 'nw-object-storage', merchantId: 'northwind-cloud', name: 'Object storage 1 TB (monthly)', description: 'Durable object storage with lifecycle policies, 1 TB.', category: 'cloud-infrastructure', priceMinor: 2300 },
  { id: 'helio-metrics-pro', merchantId: 'helio-observability', name: 'Metrics Pro (monthly)', description: 'Metrics ingestion and alerting for up to 50 services.', category: 'monitoring', priceMinor: 9900 },
  { id: 'helio-traces', merchantId: 'helio-observability', name: 'Distributed tracing add-on', description: 'Trace retention for 30 days across all services.', category: 'monitoring', priceMinor: 4900 },
  { id: 'helio-oncall', merchantId: 'helio-observability', name: 'On-call paging (monthly)', description: 'Escalation policies and paging for one on-call rotation.', category: 'monitoring', priceMinor: 2900 },
  { id: 'carto-geo-100k', merchantId: 'cartograph-data', name: 'Geocoding credits, 100k', description: '100,000 forward and reverse geocoding API calls.', category: 'data-api', priceMinor: 12000 },
  { id: 'carto-enrich-50k', merchantId: 'cartograph-data', name: 'Company enrichment, 50k', description: '50,000 company enrichment lookups.', category: 'data-api', priceMinor: 25000 },
  { id: 'quill-ci-minutes', merchantId: 'quill-software', name: 'CI minutes, 20k', description: '20,000 additional CI build minutes.', category: 'saas-software', priceMinor: 7500 },
  { id: 'quill-secret-scan', merchantId: 'quill-software', name: 'Secret scanning (monthly)', description: 'Repository secret scanning for one organisation.', category: 'saas-software', priceMinor: 5900 },

  // --- Ambiguous: plausible for a business, weak link to infrastructure ---
  { id: 'quill-design-seats', merchantId: 'quill-software', name: 'Design tool, 5 seats (monthly)', description: 'Collaborative design and prototyping, 5 seats.', category: 'saas-software', priceMinor: 6000 },
  { id: 'atlas-monitor-arm', merchantId: 'atlas-furnishings', name: 'Monitor arm', description: 'Single-monitor gas-spring desk mount.', category: 'office-furniture', priceMinor: 11900 },

  // --- Clearly outside an infrastructure mandate ---
  { id: 'atlas-standing-desk', merchantId: 'atlas-furnishings', name: 'Standing desk', description: 'Electric sit-stand desk, 160x80cm, walnut top.', category: 'office-furniture', priceMinor: 74900 },
  { id: 'atlas-task-chair', merchantId: 'atlas-furnishings', name: 'Ergonomic task chair', description: 'Mesh-back ergonomic task chair with lumbar support.', category: 'office-furniture', priceMinor: 48500 },
  { id: 'moonlit-gc-500', merchantId: 'moonlit-rewards', name: 'Gift card bundle, 500 units', description: 'Bulk digital gift cards, delivered as redemption codes.', category: 'gift-cards', priceMinor: 250000 },
  { id: 'moonlit-gc-25', merchantId: 'moonlit-rewards', name: 'Gift card, 25 units', description: 'Small digital gift card pack for team rewards.', category: 'gift-cards', priceMinor: 12500 },
];

export const merchants: Merchant[] = MERCHANT_SEEDS.map((m) => ({ ...m, receiver: receiverFor(m.id) }));

export const items: CatalogItem[] = ITEM_SEEDS.map((i) => ({ ...i, currency: config.currency }));

export function getMerchant(id: string): Merchant | undefined {
  return merchants.find((m) => m.id === id);
}

export function getItem(id: string): CatalogItem | undefined {
  return items.find((i) => i.id === id);
}

export function categories(): string[] {
  return [...new Set(items.map((i) => i.category))].sort();
}

export interface SearchHit extends CatalogItem {
  merchantName: string;
  merchantTrustTier: Merchant['trustTier'];
}

/**
 * Keyword search over the catalog. Scores name, description and category
 * matches so the agent gets usefully ordered results from a vague query.
 */
export function search(opts: { query?: string; category?: string; maxPriceMinor?: number; limit?: number } = {}): SearchHit[] {
  const terms = (opts.query ?? '')
    .toLowerCase()
    .split(/[^a-z0-9+]+/)
    .filter((t) => t.length > 2);

  const scored = items
    .filter((i) => (opts.category ? i.category === opts.category : true))
    .filter((i) => (opts.maxPriceMinor === undefined ? true : i.priceMinor <= opts.maxPriceMinor))
    .map((item) => {
      const haystackName = `${item.name}`.toLowerCase();
      const haystackRest = `${item.description} ${item.category} ${item.merchantId}`.toLowerCase();
      let score = terms.length === 0 ? 1 : 0;
      for (const t of terms) {
        if (haystackName.includes(t)) score += 3;
        else if (haystackRest.includes(t)) score += 1;
      }
      return { item, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.item.priceMinor - b.item.priceMinor);

  return scored.slice(0, opts.limit ?? 12).map(({ item }) => {
    const m = getMerchant(item.merchantId);
    return {
      ...item,
      merchantName: m?.name ?? item.merchantId,
      merchantTrustTier: m?.trustTier ?? 'UNVERIFIED',
    };
  });
}
