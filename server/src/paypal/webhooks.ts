import { config } from '../config.ts';
import { accessToken } from './client.ts';

/**
 * Webhook signature verification via PayPal's verify-webhook-signature API.
 *
 * Two things here are easy to get wrong and both silently produce FAILURE:
 *
 * 1. `webhook_event` must be the *exact bytes* PayPal signed. If you run the
 *    body through express.json() and then JSON.stringify() it back, key order
 *    and whitespace can shift and the signature no longer matches. So the
 *    verification payload is assembled by string concatenation with the raw
 *    body spliced in verbatim, and the webhook route is mounted with
 *    express.raw().
 *
 * 2. `cert_url` arrives in a header, i.e. from the network. PayPal fetches it
 *    server-side, but we validate the host anyway so a spoofed webhook cannot
 *    point our verification call at an attacker-controlled URL.
 */

export interface WebhookHeaders {
  authAlgo: string;
  certUrl: string;
  transmissionId: string;
  transmissionSig: string;
  transmissionTime: string;
}

export function readWebhookHeaders(headers: Record<string, unknown>): WebhookHeaders | undefined {
  const get = (k: string): string => {
    const v = headers[k] ?? headers[k.toLowerCase()];
    return typeof v === 'string' ? v : '';
  };
  const out: WebhookHeaders = {
    authAlgo: get('paypal-auth-algo'),
    certUrl: get('paypal-cert-url'),
    transmissionId: get('paypal-transmission-id'),
    transmissionSig: get('paypal-transmission-sig'),
    transmissionTime: get('paypal-transmission-time'),
  };
  if (!out.authAlgo || !out.certUrl || !out.transmissionId || !out.transmissionSig || !out.transmissionTime) {
    return undefined;
  }
  return out;
}

function certUrlIsTrusted(certUrl: string): boolean {
  try {
    const u = new URL(certUrl);
    return u.protocol === 'https:' && /(^|\.)paypal\.com$/i.test(u.hostname);
  } catch {
    return false;
  }
}

export type VerificationOutcome =
  | { status: 'SUCCESS' }
  | { status: 'FAILURE'; reason: string }
  | { status: 'SKIPPED'; reason: string };

export async function verifyWebhookSignature(rawBody: string, headers: WebhookHeaders): Promise<VerificationOutcome> {
  if (!config.paypal.live) {
    return { status: 'SKIPPED', reason: 'PayPal credentials not configured' };
  }
  if (!config.paypal.webhookId) {
    return { status: 'SKIPPED', reason: 'PAYPAL_WEBHOOK_ID is not set, so the signature cannot be checked' };
  }
  if (!certUrlIsTrusted(headers.certUrl)) {
    return { status: 'FAILURE', reason: `Refusing to verify against untrusted cert_url host: ${headers.certUrl}` };
  }

  // Hand-assembled so rawBody is embedded byte-for-byte.
  const payload =
    '{' +
    `"auth_algo":${JSON.stringify(headers.authAlgo)},` +
    `"cert_url":${JSON.stringify(headers.certUrl)},` +
    `"transmission_id":${JSON.stringify(headers.transmissionId)},` +
    `"transmission_sig":${JSON.stringify(headers.transmissionSig)},` +
    `"transmission_time":${JSON.stringify(headers.transmissionTime)},` +
    `"webhook_id":${JSON.stringify(config.paypal.webhookId)},` +
    `"webhook_event":${rawBody}` +
    '}';

  const token = await accessToken();
  const res = await fetch(`${config.paypal.baseUrl}/v1/notifications/verify-webhook-signature`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: payload,
    signal: AbortSignal.timeout(config.paypal.timeoutMs),
  });

  if (!res.ok) {
    const text = await res.text();
    return { status: 'FAILURE', reason: `verify-webhook-signature returned HTTP ${res.status}: ${text.slice(0, 400)}` };
  }

  const body = (await res.json()) as { verification_status?: string };
  return body.verification_status === 'SUCCESS'
    ? { status: 'SUCCESS' }
    : { status: 'FAILURE', reason: `PayPal reported verification_status=${body.verification_status}` };
}

/** Webhook event types the control plane reacts to. */
export const SUBSCRIBED_EVENTS = [
  'PAYMENT.PAYOUTSBATCH.SUCCESS',
  'PAYMENT.PAYOUTSBATCH.DENIED',
  'PAYMENT.PAYOUTSBATCH.PROCESSING',
  'PAYMENT.PAYOUTS-ITEM.SUCCEEDED',
  'PAYMENT.PAYOUTS-ITEM.FAILED',
  'PAYMENT.PAYOUTS-ITEM.DENIED',
  'PAYMENT.PAYOUTS-ITEM.RETURNED',
  'PAYMENT.PAYOUTS-ITEM.UNCLAIMED',
  'CHECKOUT.ORDER.APPROVED',
  'PAYMENT.AUTHORIZATION.CREATED',
  'PAYMENT.AUTHORIZATION.VOIDED',
  'PAYMENT.CAPTURE.COMPLETED',
  'PAYMENT.CAPTURE.DENIED',
  'PAYMENT.CAPTURE.REFUNDED',
] as const;
