import { Router, type Request, type Response } from 'express';
import express from 'express';
import { config } from '../config.ts';
import { ledger } from '../ledger/ledger.ts';
import { readWebhookHeaders, verifyWebhookSignature } from '../paypal/webhooks.ts';
import { cancelBuyerApproval, completeBuyerApproval } from '../service/spend.ts';

export const paypalRoutes = Router();

/** Minimal styled page for the browser round-trip back from PayPal. */
function page(title: string, heading: string, body: string, accent: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
  :root { color-scheme: light dark; }
  body { margin:0; min-height:100vh; display:grid; place-items:center;
         font: 15px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
         background:#0b0f17; color:#e6edf7; padding:24px; }
  .card { max-width:34rem; width:100%; background:#141b26; border:1px solid #233047;
          border-radius:14px; padding:28px; box-shadow:0 12px 40px rgba(0,0,0,.45); }
  h1 { margin:0 0 .5rem; font-size:1.25rem; color:${accent}; }
  p { margin:.5rem 0; color:#aab8cd; }
  code { background:#0b1119; padding:2px 6px; border-radius:5px; color:#cfe0f5; font-size:.9em; }
  a.btn { display:inline-block; margin-top:1.25rem; padding:.6rem 1.1rem; border-radius:9px;
          background:#2563eb; color:#fff; text-decoration:none; font-weight:600; }
</style></head>
<body><div class="card"><h1>${heading}</h1>${body}
<a class="btn" href="${config.webOrigin}">Back to the control plane</a></div></body></html>`;
}

/**
 * PayPal redirects the buyer here after they approve the order.
 *
 * This is the hinge of the human-in-the-loop rail: consent was given at
 * PayPal, not in our own UI, and only now may the control plane place the
 * authorization hold and capture it.
 */
paypalRoutes.get('/return', async (req: Request, res: Response) => {
  const requestId = typeof req.query.request === 'string' ? req.query.request : '';
  if (!requestId) {
    res.status(400).send(page('Missing request', 'Missing spend request id', '<p>The return URL did not carry a spend request id.</p>', '#f87171'));
    return;
  }

  try {
    const request = await completeBuyerApproval(requestId);
    if (request.status === 'SETTLED') {
      res.send(
        page(
          'Payment captured',
          'Payment captured',
          `<p>Spend request <code>${request.id}</code> has been authorized and captured through PayPal.</p>
           <p>Merchant: <strong>${request.merchantName}</strong><br>
              Authorization: <code>${request.settlement?.authorizationId ?? 'n/a'}</code><br>
              Capture: <code>${request.settlement?.captureId ?? 'n/a'}</code></p>
           ${request.settlement?.simulated ? '<p><strong>Note:</strong> this was simulated locally because no PayPal credentials are configured.</p>' : ''}`,
          '#34d399',
        ),
      );
      return;
    }
    res.status(502).send(
      page(
        'Capture failed',
        'Could not complete the capture',
        `<p>Spend request <code>${request.id}</code> is now <code>${request.status}</code>.</p>
         <p>${request.settlement?.error ?? 'No further detail was returned.'}</p>`,
        '#f87171',
      ),
    );
  } catch (err) {
    res.status(500).send(page('Error', 'Something went wrong', `<p>${(err as Error).message}</p>`, '#f87171'));
  }
});

/** The buyer backed out of PayPal checkout. Release the reservation. */
paypalRoutes.get('/cancel', async (req: Request, res: Response) => {
  const requestId = typeof req.query.request === 'string' ? req.query.request : '';
  if (requestId) await cancelBuyerApproval(requestId, 'Buyer cancelled at PayPal checkout');
  res.send(
    page(
      'Cancelled',
      'Approval cancelled',
      `<p>No payment was taken and the reserved funds have been released back to the mandate.</p>`,
      '#fbbf24',
    ),
  );
});

/**
 * Webhook receiver.
 *
 * Mounted with express.raw so the exact signed bytes survive for signature
 * verification -- see paypal/webhooks.ts for why re-serialising the parsed
 * JSON breaks it.
 *
 * Always answers 200 once the event is durably recorded. A non-2xx makes
 * PayPal retry, and retries on an event we already stored would just add
 * duplicate ledger entries.
 */
paypalRoutes.post('/webhook', express.raw({ type: '*/*', limit: '1mb' }), async (req: Request, res: Response) => {
  const rawBody = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : typeof req.body === 'string' ? req.body : '';

  let parsed: Record<string, any> = {};
  try {
    parsed = rawBody ? JSON.parse(rawBody) : {};
  } catch {
    res.status(400).json({ error: 'INVALID_JSON' });
    return;
  }

  const headers = readWebhookHeaders(req.headers as Record<string, unknown>);
  let verification: { status: string; reason?: string } = {
    status: 'MISSING_HEADERS',
    reason: 'Required PayPal signature headers were absent',
  };
  if (headers) {
    try {
      verification = await verifyWebhookSignature(rawBody, headers);
    } catch (err) {
      verification = { status: 'ERROR', reason: (err as Error).message };
    }
  }

  const eventType: string = parsed.event_type ?? 'UNKNOWN';
  // custom_id / invoice_id carry our spend-request id through PayPal.
  const resource = parsed.resource ?? {};
  const subject: string =
    resource.custom_id ??
    resource.invoice_id ??
    resource.sender_batch_header?.sender_batch_id?.replace(/^mandate-/, '') ??
    parsed.id ??
    'webhook';

  ledger().append({
    type: 'WEBHOOK_RECEIVED',
    subject,
    actor: 'paypal',
    summary: `Webhook ${eventType} (signature: ${verification.status})`,
    data: {
      eventType,
      verification,
      paypalEventId: parsed.id,
      resourceType: parsed.resource_type,
      resource,
    },
  });

  // A forged or unverifiable event is recorded for forensics but never acted on.
  if (verification.status === 'SUCCESS' || verification.status === 'SKIPPED') {
    try {
      if (eventType === 'CHECKOUT.ORDER.APPROVED' && typeof resource.custom_id === 'string') {
        // The buyer approved out of band (e.g. in the PayPal app). Finish it.
        await completeBuyerApproval(resource.custom_id).catch(() => undefined);
      }
    } catch {
      /* already captured in the ledger; never fail the webhook */
    }
  }

  res.status(200).json({ received: true, verification: verification.status });
});

/**
 * Stand-in for PayPal's hosted checkout, used only when credentials are
 * absent. It exists so the escalation -> buyer-approval -> capture path is
 * clickable in the no-credential demo instead of dead-ending on a link to
 * paypal.com that would reject an unknown token.
 */
paypalRoutes.get('/simulate/checkout', (req: Request, res: Response) => {
  const token = typeof req.query.token === 'string' ? req.query.token : '';
  const request = ledger()
    .listRequests({ limit: 500 })
    .find((r) => r.settlement?.paypalId === token);

  if (!request) {
    res.status(404).send(page('Unknown order', 'Unknown simulated order', `<p>No spend request is attached to order <code>${token}</code>.</p>`, '#f87171'));
    return;
  }

  res.send(
    page(
      'Simulated PayPal approval',
      'Simulated PayPal checkout',
      `<p>This page stands in for PayPal's hosted approval screen because no PayPal credentials are configured.</p>
       <p>Order <code>${request.settlement?.paypalId}</code><br>
          Amount <strong>${(request.amountMinor / 100).toFixed(2)} ${request.currency}</strong><br>
          Merchant <strong>${request.merchantName}</strong></p>
       <p>Approving here triggers the same authorize-then-capture sequence the real flow uses.</p>
       <a class="btn" href="${config.publicUrl}/api/paypal/return?request=${encodeURIComponent(request.id)}">Approve and capture</a>`,
      '#60a5fa',
    ),
  );
});
