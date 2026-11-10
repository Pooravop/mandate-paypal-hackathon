import { config } from '../config.ts';
import { request, type PayPalLink } from './client.ts';
import { payoutAmount } from '../util/money.ts';
import { simulatedPayout } from './simulator.ts';

/**
 * Rail 1: PayPal Payouts v1 -- the autonomous rail.
 *
 * This is what makes agent-initiated payment genuinely headless. Orders v2
 * requires a buyer to approve in a browser, which is fine for a human
 * checkout but fatal for an agent acting under a standing mandate. Payouts
 * moves funds from the mandate holder's PayPal balance straight to the
 * merchant's PayPal account over server-to-server calls, with no redirect.
 *
 * API quirk that bites everyone: Payouts v1 amounts use `currency`, while
 * Orders v2 and Payments v2 use `currency_code`. The two helpers in
 * util/money.ts keep them straight.
 */

export interface PayoutBatchHeader {
  payout_batch_id: string;
  batch_status: 'DENIED' | 'PENDING' | 'PROCESSING' | 'SUCCESS' | 'CANCELED';
  time_created?: string;
  time_completed?: string;
  amount?: { currency: string; value: string };
  fees?: { currency: string; value: string };
  sender_batch_header?: Record<string, unknown>;
}

export interface PayoutItem {
  payout_item_id: string;
  transaction_id?: string;
  transaction_status?: string;
  payout_item?: Record<string, unknown>;
  errors?: Record<string, unknown>;
  time_processed?: string;
}

export interface PayoutResponse {
  batch_header: PayoutBatchHeader;
  items?: PayoutItem[];
  links?: PayPalLink[];
  simulated?: boolean;
}

export interface CreatePayoutArgs {
  /**
   * Must be stable per logical payout. PayPal rejects a duplicate
   * sender_batch_id seen within 30 days, which is our double-spend backstop
   * even if the control plane itself is restarted mid-settlement.
   */
  senderBatchId: string;
  receiverEmail: string;
  amountMinor: number;
  currency: string;
  note: string;
  senderItemId: string;
  emailSubject?: string;
  emailMessage?: string;
  idempotencyKey: string;
}

export async function createPayout(args: CreatePayoutArgs): Promise<PayoutResponse> {
  if (!config.paypal.live) return simulatedPayout(args) as unknown as PayoutResponse;

  const body = {
    sender_batch_header: {
      sender_batch_id: args.senderBatchId,
      recipient_type: 'EMAIL',
      email_subject: args.emailSubject ?? 'A payment was sent on your behalf',
      email_message: args.emailMessage ?? args.note,
      note: args.note.slice(0, 1000),
    },
    items: [
      {
        recipient_type: 'EMAIL',
        receiver: args.receiverEmail,
        amount: payoutAmount(args.amountMinor, args.currency),
        note: args.note.slice(0, 4000),
        sender_item_id: args.senderItemId,
        purpose: 'GOODS',
      },
    ],
  };

  return request<PayoutResponse>({
    method: 'POST',
    path: '/v1/payments/payouts',
    body,
    idempotencyKey: args.idempotencyKey,
  });
}

/** Poll a batch. PayPal accepts as PENDING then settles asynchronously. */
export async function getPayout(batchId: string): Promise<PayoutResponse> {
  if (!config.paypal.live) {
    return {
      simulated: true,
      batch_header: {
        payout_batch_id: batchId,
        batch_status: 'SUCCESS',
        time_completed: new Date().toISOString(),
      },
      items: [],
    };
  }
  return request<PayoutResponse>({ method: 'GET', path: `/v1/payments/payouts/${encodeURIComponent(batchId)}` });
}

export async function getPayoutItem(payoutItemId: string): Promise<PayoutItem> {
  if (!config.paypal.live) {
    return { payout_item_id: payoutItemId, transaction_status: 'SUCCESS' };
  }
  return request<PayoutItem>({ method: 'GET', path: `/v1/payments/payouts-item/${encodeURIComponent(payoutItemId)}` });
}

/** Cancel an unclaimed item -- the recipient had no PayPal account yet. */
export async function cancelPayoutItem(payoutItemId: string): Promise<PayoutItem> {
  if (!config.paypal.live) {
    return { payout_item_id: payoutItemId, transaction_status: 'RETURNED' };
  }
  return request<PayoutItem>({
    method: 'POST',
    path: `/v1/payments/payouts-item/${encodeURIComponent(payoutItemId)}/cancel`,
  });
}

/**
 * Whether a batch/item status means funds are irrevocably on their way.
 * UNCLAIMED is deliberately treated as still-committed: PayPal is holding the
 * money for a recipient who has not signed up yet, so the mandate stays debited.
 */
export function isCommitted(status: string | undefined): boolean {
  return ['SUCCESS', 'PENDING', 'PROCESSING', 'UNCLAIMED', 'ONHOLD'].includes((status ?? '').toUpperCase());
}

export function isFailed(status: string | undefined): boolean {
  return ['DENIED', 'FAILED', 'CANCELED', 'RETURNED', 'BLOCKED', 'REVERSED', 'REFUNDED'].includes((status ?? '').toUpperCase());
}
