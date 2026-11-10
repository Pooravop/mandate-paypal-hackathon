import { randomUUID } from 'node:crypto';
import { config } from '../config.ts';
import { toDecimalString } from '../util/money.ts';

/**
 * Local stand-in for the PayPal REST API, used only when no credentials are
 * configured.
 *
 * Its job is to let a reviewer clone the repo and watch the full control-plane
 * flow -- policy, adjudication, escalation, settlement, audit chain -- without
 * first registering a developer app. It mimics PayPal's response *shapes*
 * faithfully so the surrounding code is identical on both paths, and every
 * object it produces is tagged `simulated: true` and surfaced in the UI as
 * "SIMULATED" so nobody can mistake it for real money movement.
 */

function ref(prefix: string): string {
  return prefix + randomUUID().replace(/-/g, '').slice(0, 14).toUpperCase();
}

export function simulatedPayout(args: {
  senderBatchId: string;
  receiverEmail: string;
  amountMinor: number;
  currency: string;
  note: string;
  senderItemId: string;
}) {
  const batchId = ref('SIMBATCH');
  return {
    simulated: true as const,
    batch_header: {
      payout_batch_id: batchId,
      // PayPal returns PENDING on accept, then moves to SUCCESS asynchronously.
      batch_status: 'PENDING',
      time_created: new Date().toISOString(),
      sender_batch_header: {
        sender_batch_id: args.senderBatchId,
        recipient_type: 'EMAIL',
        email_subject: 'You have a payment',
      },
      amount: { currency: args.currency, value: toDecimalString(args.amountMinor, args.currency) },
    },
    items: [
      {
        payout_item_id: ref('SIMITEM'),
        transaction_id: ref('SIMTXN'),
        transaction_status: 'PENDING',
        payout_item: {
          recipient_type: 'EMAIL',
          amount: { currency: args.currency, value: toDecimalString(args.amountMinor, args.currency) },
          receiver: args.receiverEmail,
          note: args.note,
          sender_item_id: args.senderItemId,
        },
      },
    ],
    links: [{ href: `${config.paypal.baseUrl}/v1/payments/payouts/${batchId}`, rel: 'self', method: 'GET' }],
  };
}

export function simulatedOrder(args: {
  amountMinor: number;
  currency: string;
  description: string;
  returnUrl: string;
  cancelUrl: string;
}) {
  const orderId = ref('SIMORDER');
  return {
    simulated: true as const,
    id: orderId,
    status: 'CREATED',
    intent: 'AUTHORIZE',
    purchase_units: [
      {
        description: args.description,
        amount: { currency_code: args.currency, value: toDecimalString(args.amountMinor, args.currency) },
      },
    ],
    links: [
      { href: `${config.paypal.baseUrl}/v2/checkout/orders/${orderId}`, rel: 'self', method: 'GET' },
      // Points at our own simulated-checkout page rather than paypal.com, so a
      // reviewer clicking it lands somewhere that actually works offline.
      { href: `${config.publicUrl}/api/paypal/simulate/checkout?token=${orderId}`, rel: 'approve', method: 'GET' },
      { href: `${config.paypal.baseUrl}/v2/checkout/orders/${orderId}/authorize`, rel: 'authorize', method: 'POST' },
    ],
  };
}

export function simulatedAuthorization(args: { orderId: string; amountMinor: number; currency: string }) {
  return {
    simulated: true as const,
    id: args.orderId,
    status: 'COMPLETED',
    purchase_units: [
      {
        payments: {
          authorizations: [
            {
              id: ref('SIMAUTH'),
              status: 'CREATED',
              amount: { currency_code: args.currency, value: toDecimalString(args.amountMinor, args.currency) },
              expiration_time: new Date(Date.now() + 29 * 864e5).toISOString(),
            },
          ],
        },
      },
    ],
  };
}

export function simulatedCapture(args: { amountMinor: number; currency: string }) {
  return {
    simulated: true as const,
    id: ref('SIMCAP'),
    status: 'COMPLETED',
    final_capture: true,
    amount: { currency_code: args.currency, value: toDecimalString(args.amountMinor, args.currency) },
  };
}

export function simulatedVoid() {
  return { simulated: true as const, id: ref('SIMVOID'), status: 'VOIDED' };
}

export function simulatedRefund(args: { amountMinor: number; currency: string }) {
  return {
    simulated: true as const,
    id: ref('SIMREF'),
    status: 'COMPLETED',
    amount: { currency_code: args.currency, value: toDecimalString(args.amountMinor, args.currency) },
  };
}
