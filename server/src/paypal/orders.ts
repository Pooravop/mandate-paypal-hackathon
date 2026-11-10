import { config } from '../config.ts';
import { request, findLink, type PayPalLink } from './client.ts';
import { orderAmount } from '../util/money.ts';
import {
  simulatedOrder,
  simulatedAuthorization,
  simulatedCapture,
  simulatedVoid,
  simulatedRefund,
} from './simulator.ts';

/**
 * Rail 2: Orders v2 with intent=AUTHORIZE -- the human-in-the-loop rail.
 *
 * When the policy engine or the AI adjudicator escalates a spend, we do not
 * just show a dialog in our own UI and call it consent. We create a real
 * PayPal order and hand the human the real PayPal approval URL. The human
 * authenticates with PayPal itself and approves the hold. Only then can the
 * control plane authorize and capture.
 *
 * Authorize-then-capture is the right shape for agent commerce: the hold can
 * sit for up to 29 days and be voided for free if the agent turns out to have
 * been wrong, instead of needing a refund after the fact.
 *
 * Constraint from the docs: intent=AUTHORIZE does not support more than one
 * purchase_unit, so each spend request maps to exactly one order.
 */

export interface OrderResponse {
  id: string;
  status: 'CREATED' | 'SAVED' | 'APPROVED' | 'PAYER_ACTION_REQUIRED' | 'VOIDED' | 'COMPLETED';
  intent?: string;
  purchase_units?: Array<{
    reference_id?: string;
    description?: string;
    custom_id?: string;
    invoice_id?: string;
    amount?: { currency_code: string; value: string };
    payments?: {
      authorizations?: Array<{
        id: string;
        status: string;
        amount?: { currency_code: string; value: string };
        expiration_time?: string;
        links?: PayPalLink[];
      }>;
      captures?: Array<{ id: string; status: string; amount?: { currency_code: string; value: string } }>;
    };
  }>;
  links?: PayPalLink[];
  simulated?: boolean;
}

export interface CreateOrderArgs {
  amountMinor: number;
  currency: string;
  description: string;
  /** Our spend-request id, echoed back by PayPal and on webhooks. */
  customId: string;
  invoiceId?: string;
  returnUrl: string;
  cancelUrl: string;
  /** Sandbox business account that receives the funds. */
  payeeEmail?: string;
  brandName?: string;
  idempotencyKey: string;
}

export async function createAuthorizeOrder(args: CreateOrderArgs): Promise<OrderResponse> {
  if (!config.paypal.live) return simulatedOrder(args) as unknown as OrderResponse;

  const purchaseUnit: Record<string, unknown> = {
    reference_id: args.customId,
    // PayPal caps description at 127 chars and rejects the whole order if longer.
    description: args.description.slice(0, 127),
    custom_id: args.customId,
    amount: orderAmount(args.amountMinor, args.currency),
  };
  if (args.invoiceId) purchaseUnit.invoice_id = args.invoiceId;
  if (args.payeeEmail) purchaseUnit.payee = { email_address: args.payeeEmail };

  const body = {
    intent: 'AUTHORIZE',
    purchase_units: [purchaseUnit],
    payment_source: {
      paypal: {
        experience_context: {
          brand_name: (args.brandName ?? 'Mandate Control Plane').slice(0, 127),
          locale: 'en-US',
          landing_page: 'LOGIN',
          // Digital/agent purchases carry no shipping leg, and asking for an
          // address would make the sandbox approval flow needlessly fiddly.
          shipping_preference: 'NO_SHIPPING',
          user_action: 'PAY_NOW',
          payment_method_preference: 'IMMEDIATE_PAYMENT_REQUIRED',
          return_url: args.returnUrl,
          cancel_url: args.cancelUrl,
        },
      },
    },
  };

  return request<OrderResponse>({
    method: 'POST',
    path: '/v2/checkout/orders',
    body,
    idempotencyKey: args.idempotencyKey,
    representation: true,
  });
}

export async function getOrder(orderId: string): Promise<OrderResponse> {
  if (!config.paypal.live) {
    return { simulated: true, id: orderId, status: 'APPROVED' };
  }
  return request<OrderResponse>({ method: 'GET', path: `/v2/checkout/orders/${encodeURIComponent(orderId)}` });
}

/**
 * Place the authorization hold on an order the buyer has already approved.
 * Returns the authorization id needed for capture/void.
 */
export async function authorizeOrder(
  orderId: string,
  idempotencyKey: string,
  sim?: { amountMinor: number; currency: string },
): Promise<OrderResponse> {
  if (!config.paypal.live) {
    return simulatedAuthorization({
      orderId,
      amountMinor: sim?.amountMinor ?? 0,
      currency: sim?.currency ?? config.currency,
    }) as unknown as OrderResponse;
  }
  return request<OrderResponse>({
    method: 'POST',
    path: `/v2/checkout/orders/${encodeURIComponent(orderId)}/authorize`,
    body: {},
    idempotencyKey,
    representation: true,
  });
}

export interface CaptureResponse {
  id: string;
  status: string;
  amount?: { currency_code: string; value: string };
  final_capture?: boolean;
  links?: PayPalLink[];
  simulated?: boolean;
}

export async function captureAuthorization(args: {
  authorizationId: string;
  amountMinor: number;
  currency: string;
  noteToPayer?: string;
  invoiceId?: string;
  idempotencyKey: string;
}): Promise<CaptureResponse> {
  if (!config.paypal.live) {
    return simulatedCapture(args) as unknown as CaptureResponse;
  }
  const body: Record<string, unknown> = {
    amount: orderAmount(args.amountMinor, args.currency),
    final_capture: true,
  };
  if (args.noteToPayer) body.note_to_payer = args.noteToPayer.slice(0, 255);
  if (args.invoiceId) body.invoice_id = args.invoiceId.slice(0, 127);

  return request<CaptureResponse>({
    method: 'POST',
    path: `/v2/payments/authorizations/${encodeURIComponent(args.authorizationId)}/capture`,
    body,
    idempotencyKey: args.idempotencyKey,
    representation: true,
  });
}

/** Release a hold at no cost -- the correct undo for an escalation that was denied. */
export async function voidAuthorization(authorizationId: string, idempotencyKey: string): Promise<unknown> {
  if (!config.paypal.live) return simulatedVoid();
  return request<unknown>({
    method: 'POST',
    path: `/v2/payments/authorizations/${encodeURIComponent(authorizationId)}/void`,
    idempotencyKey,
    representation: true,
  });
}

export interface RefundResponse {
  id: string;
  status: string;
  amount?: { currency_code: string; value: string };
  simulated?: boolean;
}

/** Omit amountMinor for a full refund (PayPal wants an empty body in that case). */
export async function refundCapture(args: {
  captureId: string;
  amountMinor?: number;
  currency: string;
  noteToPayer?: string;
  invoiceId?: string;
  idempotencyKey: string;
}): Promise<RefundResponse> {
  if (!config.paypal.live) {
    return simulatedRefund({ amountMinor: args.amountMinor ?? 0, currency: args.currency }) as unknown as RefundResponse;
  }
  const body: Record<string, unknown> = {};
  if (args.amountMinor !== undefined) body.amount = orderAmount(args.amountMinor, args.currency);
  if (args.noteToPayer) body.note_to_payer = args.noteToPayer.slice(0, 255);
  if (args.invoiceId) body.invoice_id = args.invoiceId.slice(0, 127);

  return request<RefundResponse>({
    method: 'POST',
    path: `/v2/payments/captures/${encodeURIComponent(args.captureId)}/refund`,
    body,
    idempotencyKey: args.idempotencyKey,
    representation: true,
  });
}

/** The URL the human must visit to approve. PayPal uses `approve`, or
 * `payer-action` when the order is in PAYER_ACTION_REQUIRED. */
export function approvalUrl(order: OrderResponse): string | undefined {
  return findLink(order.links, 'payer-action', 'approve');
}

export function firstAuthorizationId(order: OrderResponse): string | undefined {
  return order.purchase_units?.[0]?.payments?.authorizations?.[0]?.id;
}

export function firstCaptureId(order: OrderResponse): string | undefined {
  return order.purchase_units?.[0]?.payments?.captures?.[0]?.id;
}
