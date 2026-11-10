import { config } from '../config.ts';
import { ledger } from '../ledger/ledger.ts';
import { id as newId, idempotencyKey } from '../util/ids.ts';
import { format, toMinor } from '../util/money.ts';
import { availableMinor, combine, evaluate } from '../policy/engine.ts';
import { adjudicate, buildAdjudicationInput } from '../ai/adjudicator.ts';
import { getItem, getMerchant, search } from '../catalog.ts';
import { PayPalError } from '../paypal/client.ts';
import { createPayout, getPayout, isFailed } from '../paypal/payouts.ts';
import {
  approvalUrl,
  authorizeOrder,
  captureAuthorization,
  createAuthorizeOrder,
  firstAuthorizationId,
  refundCapture,
  voidAuthorization,
} from '../paypal/orders.ts';
import { DomainError, getMandateOrThrow } from './mandates.ts';
import { HumanDecisionInput, RefundInput, SpendRequestInput } from './schemas.ts';
import type { Merchant, Settlement, SpendRequest } from '../types.ts';

/**
 * The spend pipeline.
 *
 * One request walks a fixed path, and every transition is an appended ledger
 * event, so the "why" behind any payment is reconstructable months later:
 *
 *   SPEND_REQUESTED
 *     -> POLICY_EVALUATED        deterministic rules (can terminally deny)
 *     -> AI_ADJUDICATED          intent alignment (can deny or escalate)
 *     -> one of:
 *          DENIED
 *          PENDING_HUMAN  -> HUMAN_DECIDED -> buyer approval -> capture
 *          APPROVED       -> Payouts settlement (fully autonomous)
 *
 * Funds are *reserved* the moment a request is approved or escalated and only
 * converted to *spent* when PayPal confirms. Without that reservation step a
 * burst of concurrent agent requests could each individually pass the budget
 * check and collectively overspend the mandate.
 */

interface ResolvedPurchase {
  merchant: Merchant;
  amountMinor: number;
  currency: string;
  description: string;
  category: string;
  itemRefs: string[];
}

function resolvePurchase(input: ReturnType<typeof SpendRequestInput.parse>, mandateCurrency: string): ResolvedPurchase {
  const currency = input.currency ?? mandateCurrency;

  if (input.itemIds.length > 0) {
    const resolved = input.itemIds.map((itemId) => {
      const item = getItem(itemId);
      if (!item) throw new DomainError('ITEM_NOT_FOUND', `No catalog item with id "${itemId}"`);
      return item;
    });

    const merchantIds = [...new Set(resolved.map((i) => i.merchantId))];
    if (merchantIds.length > 1) {
      // Orders v2 with intent=AUTHORIZE allows only one purchase_unit, and a
      // payout goes to a single receiver, so a request cannot span merchants.
      throw new DomainError(
        'MULTIPLE_MERCHANTS',
        `A single spend request must settle to one merchant, but these items span: ${merchantIds.join(', ')}`,
      );
    }
    const merchantId = merchantIds[0] as string;
    if (input.merchantId && input.merchantId !== merchantId) {
      throw new DomainError('MERCHANT_MISMATCH', `Items belong to "${merchantId}" but the request names "${input.merchantId}"`);
    }
    const merchant = getMerchant(merchantId);
    if (!merchant) throw new DomainError('MERCHANT_NOT_FOUND', `No merchant with id "${merchantId}"`);

    const mismatched = resolved.find((i) => i.currency.toUpperCase() !== currency.toUpperCase());
    if (mismatched) {
      throw new DomainError('CURRENCY_MISMATCH', `Item "${mismatched.id}" is priced in ${mismatched.currency}, not ${currency}`);
    }

    const itemsTotal = resolved.reduce((s, i) => s + i.priceMinor, 0);
    // An explicit amount may not undercut the catalog price; that would let an
    // agent buy a $749 desk while declaring a $9 spend.
    const amountMinor = input.amount !== undefined ? toMinor(input.amount, currency) : itemsTotal;
    if (input.amount !== undefined && amountMinor !== itemsTotal) {
      throw new DomainError(
        'AMOUNT_DISAGREES_WITH_ITEMS',
        `Stated amount ${format(amountMinor, currency)} does not match the catalog total ${format(itemsTotal, currency)} for the selected items`,
      );
    }

    return {
      merchant,
      amountMinor,
      currency,
      description: input.description ?? resolved.map((i) => i.name).join(' + '),
      category: input.category ?? (resolved[0] as { category: string }).category,
      itemRefs: resolved.map((i) => i.id),
    };
  }

  // Off-catalog purchase: the agent must supply everything explicitly.
  if (!input.merchantId) throw new DomainError('MERCHANT_REQUIRED', 'merchantId is required when no itemIds are given');
  if (input.amount === undefined) throw new DomainError('AMOUNT_REQUIRED', 'amount is required when no itemIds are given');
  const merchant = getMerchant(input.merchantId);
  if (!merchant) throw new DomainError('MERCHANT_NOT_FOUND', `No merchant with id "${input.merchantId}"`);

  return {
    merchant,
    amountMinor: toMinor(input.amount, currency),
    currency,
    description: input.description ?? `Off-catalog purchase from ${merchant.name}`,
    category: input.category ?? merchant.category,
    itemRefs: [],
  };
}

function patchRequest(
  request: SpendRequest,
  patch: Partial<SpendRequest>,
  event: {
    type: Parameters<ReturnType<typeof ledger>['append']>[0]['type'];
    actor: string;
    summary: string;
    data?: Record<string, unknown>;
    accounting?: { mandateId: string; reservedDelta?: number; spentDelta?: number; refundedDelta?: number };
  },
): SpendRequest {
  ledger().append({
    type: event.type,
    subject: request.id,
    actor: event.actor,
    summary: event.summary,
    data: {
      ...event.data,
      requestId: request.id,
      requestPatch: patch,
      ...(event.accounting ? { accounting: event.accounting } : {}),
    },
  });
  return { ...request, ...patch, updatedAt: new Date().toISOString() };
}

/** Run a spend request through the full gate. */
export async function requestSpend(raw: unknown): Promise<SpendRequest> {
  const input = SpendRequestInput.parse(raw);
  const mandate = getMandateOrThrow(input.mandateId);
  const purchase = resolvePurchase(input, mandate.currency);

  const now = new Date().toISOString();
  let request: SpendRequest = {
    id: newId('spr'),
    mandateId: mandate.id,
    agentName: input.agentName || mandate.agentName,
    merchantId: purchase.merchant.id,
    merchantName: purchase.merchant.name,
    merchantReceiver: purchase.merchant.receiver,
    category: purchase.category,
    description: purchase.description,
    justification: input.justification,
    itemRefs: purchase.itemRefs,
    currency: purchase.currency,
    amountMinor: purchase.amountMinor,
    rail: 'PAYOUT',
    status: 'PENDING_POLICY',
    createdAt: now,
    updatedAt: now,
  };

  ledger().append({
    type: 'SPEND_REQUESTED',
    subject: request.id,
    actor: request.agentName,
    summary: `${request.agentName} requested ${format(request.amountMinor, request.currency)} to ${request.merchantName} for "${request.description}"`,
    data: { request, mandateId: mandate.id },
  });

  // --- Stage 1: deterministic rules -------------------------------------
  const windowStart = new Date(Date.now() - mandate.rules.velocity.windowHours * 3.6e6).toISOString();
  const prior = ledger().requestsSince(mandate.id, windowStart);
  const policy = evaluate({
    mandate,
    request,
    merchant: purchase.merchant,
    priorInWindow: prior.map((r) => ({
      amountMinor: r.amountMinor,
      merchantId: r.merchantId,
      createdAt: r.createdAt,
      description: r.description,
    })),
  });

  request = patchRequest(request, { policy }, {
    type: 'POLICY_EVALUATED',
    actor: 'policy-engine',
    summary: `Policy engine: ${policy.decision} - ${policy.reason}`,
    data: { policy },
  });

  if (policy.terminal) {
    return patchRequest(request, { status: 'DENIED' }, {
      type: 'DECISION_APPLIED',
      actor: 'policy-engine',
      summary: `Denied by deterministic policy: ${policy.reason}`,
      data: { decision: 'DENY', byPolicy: true },
    });
  }

  // --- Stage 2: AI intent adjudication ----------------------------------
  const adjudication = await adjudicate(
    buildAdjudicationInput({
      mandate,
      availableMinor: availableMinor(mandate),
      request,
      merchantName: purchase.merchant.name,
      merchantTrustTier: purchase.merchant.trustTier,
      policyRules: policy.rules,
      recent: prior,
    }),
  );

  request = patchRequest(request, { adjudication }, {
    type: 'AI_ADJUDICATED',
    actor: `${adjudication.provider}:${adjudication.model}`,
    summary: `AI adjudicator: ${adjudication.decision} (confidence ${adjudication.confidence.toFixed(2)}) - ${adjudication.rationale.slice(0, 160)}`,
    data: { adjudication },
  });

  // --- Stage 3: combine and act -----------------------------------------
  const outcome = combine(policy, adjudication);

  if (outcome.decision === 'DENY') {
    return patchRequest(request, { status: 'DENIED' }, {
      type: 'DECISION_APPLIED',
      actor: 'control-plane',
      summary: `Denied: ${outcome.reason}`,
      data: { decision: 'DENY', reason: outcome.reason },
    });
  }

  /**
   * Commit point.
   *
   * Stage 1 evaluated the mandate as it stood *before* the adjudicator was
   * awaited. Concurrent requests all pass that first check against the same
   * balance, so committing on it would let N requests that each fit
   * individually overspend the mandate collectively.
   *
   * So the limits are re-evaluated here and the reservation is appended in the
   * same synchronous block. Node runs one callback at a time, and there is no
   * `await` between reading the mandate and writing the reservation, so no
   * other request can interleave: this sequence is effectively atomic. The
   * reservation is what makes the next request see the committed funds.
   */
  const latest = getMandateOrThrow(mandate.id);
  const recheckWindowStart = new Date(Date.now() - latest.rules.velocity.windowHours * 3.6e6).toISOString();
  const recheck = evaluate({
    mandate: latest,
    request,
    merchant: purchase.merchant,
    priorInWindow: ledger()
      .requestsSince(latest.id, recheckWindowStart)
      .filter((r) => r.id !== request.id)
      .map((r) => ({
        amountMinor: r.amountMinor,
        merchantId: r.merchantId,
        createdAt: r.createdAt,
        description: r.description,
      })),
  });

  if (recheck.decision === 'DENY') {
    return patchRequest(request, { status: 'DENIED', policy: recheck }, {
      type: 'DECISION_APPLIED',
      actor: 'control-plane',
      summary: `Denied at the commit check - the mandate changed while this request was being adjudicated: ${recheck.reason}`,
      data: { decision: 'DENY', reason: recheck.reason, raceLost: true },
    });
  }

  if (outcome.decision === 'ESCALATE') {
    return patchRequest(
      request,
      { status: 'PENDING_HUMAN', rail: 'ORDER_AUTHORIZE' },
      {
        type: 'ESCALATED',
        actor: 'control-plane',
        summary: `Escalated to a human: ${outcome.reason}`,
        data: { reason: outcome.reason },
        accounting: { mandateId: mandate.id, reservedDelta: request.amountMinor },
      },
    );
  }

  request = patchRequest(
    request,
    { status: 'APPROVED', rail: 'PAYOUT' },
    {
      type: 'DECISION_APPLIED',
      actor: 'control-plane',
      summary: `Approved autonomously: ${outcome.reason}`,
      data: { decision: 'APPROVE', reason: outcome.reason, autonomous: true },
      accounting: { mandateId: mandate.id, reservedDelta: request.amountMinor },
    },
  );

  return settleViaPayout(request);
}

/**
 * Rail 1 settlement: server-to-server Payouts, no human present.
 * Uses the spend-request id as both sender_batch_id and PayPal-Request-Id so a
 * retry after a crash cannot pay the merchant twice.
 */
export async function settleViaPayout(request: SpendRequest): Promise<SpendRequest> {
  const batchId = `mandate-${request.id}`;
  ledger().append({
    type: 'SETTLEMENT_ATTEMPTED',
    subject: request.id,
    actor: 'control-plane',
    summary: `Settling ${format(request.amountMinor, request.currency)} to ${request.merchantName} via PayPal Payouts`,
    data: { requestId: request.id, rail: 'PAYOUT', senderBatchId: batchId, live: config.paypal.live },
  });

  try {
    const res = await createPayout({
      senderBatchId: batchId,
      receiverEmail: request.merchantReceiver,
      amountMinor: request.amountMinor,
      currency: request.currency,
      note: `${request.description} (mandate ${request.mandateId})`,
      senderItemId: request.id,
      emailSubject: `Payment from an agent under mandate ${request.mandateId}`,
      idempotencyKey: idempotencyKey('payout', request.id),
      ...(config.paypal.live ? {} : {}),
    });

    const batchStatus = res.batch_header?.batch_status ?? 'PENDING';

    if (isFailed(batchStatus)) {
      const settlement: Settlement = {
        rail: 'PAYOUT',
        simulated: Boolean(res.simulated),
        status: batchStatus,
        paypalId: res.batch_header?.payout_batch_id,
        raw: res,
        error: `PayPal returned batch_status=${batchStatus}`,
        at: new Date().toISOString(),
      };
      return patchRequest(request, { status: 'SETTLEMENT_FAILED', settlement }, {
        type: 'SETTLEMENT_FAILED',
        actor: 'paypal',
        summary: `Payout rejected by PayPal (batch_status=${batchStatus})`,
        data: { settlement },
        accounting: { mandateId: request.mandateId, reservedDelta: -request.amountMinor },
      });
    }

    const settlement: Settlement = {
      rail: 'PAYOUT',
      simulated: Boolean(res.simulated),
      status: batchStatus,
      paypalId: res.batch_header?.payout_batch_id,
      payoutItemId: res.items?.[0]?.payout_item_id,
      raw: res,
      at: new Date().toISOString(),
    };

    return patchRequest(request, { status: 'SETTLED', settlement }, {
      type: 'SETTLEMENT_SUCCEEDED',
      actor: 'paypal',
      summary: `Paid ${format(request.amountMinor, request.currency)} to ${request.merchantName} - payout batch ${settlement.paypalId} (${batchStatus})${settlement.simulated ? ' [SIMULATED]' : ''}`,
      data: { settlement },
      accounting: {
        mandateId: request.mandateId,
        reservedDelta: -request.amountMinor,
        spentDelta: request.amountMinor,
      },
    });
  } catch (err) {
    const settlement: Settlement = {
      rail: 'PAYOUT',
      simulated: !config.paypal.live,
      status: 'ERROR',
      error: err instanceof PayPalError ? err.summary : (err as Error).message,
      raw: err instanceof PayPalError ? err.toJSON() : undefined,
      at: new Date().toISOString(),
    };
    // Release the reservation: the money did not move, so the mandate must not
    // stay encumbered.
    return patchRequest(request, { status: 'SETTLEMENT_FAILED', settlement }, {
      type: 'SETTLEMENT_FAILED',
      actor: 'paypal',
      summary: `Payout failed: ${settlement.error}`,
      data: { settlement },
      accounting: { mandateId: request.mandateId, reservedDelta: -request.amountMinor },
    });
  }
}

function getRequestOrThrow(id: string): SpendRequest {
  const r = ledger().getRequest(id);
  if (!r) throw new DomainError('REQUEST_NOT_FOUND', `No spend request with id ${id}`, 404);
  return r;
}

/**
 * A human resolves an escalation.
 *
 * On approval we do not simply flip a flag in our own database and call that
 * consent. We create a real PayPal order and hand back PayPal's own approval
 * URL, so the human authenticates with PayPal and authorises the hold there.
 */
export async function decideHuman(requestId: string, raw: unknown): Promise<SpendRequest> {
  const input = HumanDecisionInput.parse(raw);
  let request = getRequestOrThrow(requestId);

  if (request.status !== 'PENDING_HUMAN') {
    throw new DomainError('NOT_PENDING', `Spend request ${requestId} is ${request.status}, not awaiting a human decision`, 409);
  }

  const humanDecision = {
    by: input.by,
    decision: input.decision,
    note: input.note,
    at: new Date().toISOString(),
  };

  if (input.decision === 'DENY') {
    return patchRequest(request, { status: 'DENIED', humanDecision }, {
      type: 'HUMAN_DECIDED',
      actor: input.by,
      summary: `${input.by} denied ${format(request.amountMinor, request.currency)} to ${request.merchantName}${input.note ? `: ${input.note}` : ''}`,
      data: { humanDecision },
      accounting: { mandateId: request.mandateId, reservedDelta: -request.amountMinor },
    });
  }

  // Re-check the mandate: it may have been revoked or expired while the
  // request sat in the approval queue.
  const mandate = getMandateOrThrow(request.mandateId);
  if (mandate.status !== 'ACTIVE') {
    return patchRequest(request, { status: 'DENIED', humanDecision }, {
      type: 'DECISION_APPLIED',
      actor: 'control-plane',
      summary: `Approval rejected: mandate is now ${mandate.status}`,
      data: { humanDecision, mandateStatus: mandate.status },
      accounting: { mandateId: request.mandateId, reservedDelta: -request.amountMinor },
    });
  }

  request = patchRequest(request, { status: 'APPROVED', humanDecision }, {
    type: 'HUMAN_DECIDED',
    actor: input.by,
    summary: `${input.by} approved ${format(request.amountMinor, request.currency)} to ${request.merchantName}${input.note ? `: ${input.note}` : ''}`,
    data: { humanDecision },
  });

  return beginBuyerApproval(request);
}

/** Rail 2 step 1: create the order and expose PayPal's approval URL. */
export async function beginBuyerApproval(request: SpendRequest): Promise<SpendRequest> {
  const returnUrl = `${config.publicUrl}/api/paypal/return?request=${encodeURIComponent(request.id)}`;
  const cancelUrl = `${config.publicUrl}/api/paypal/cancel?request=${encodeURIComponent(request.id)}`;

  try {
    const order = await createAuthorizeOrder({
      amountMinor: request.amountMinor,
      currency: request.currency,
      description: request.description,
      customId: request.id,
      invoiceId: request.id,
      returnUrl,
      cancelUrl,
      payeeEmail: config.paypal.payeeEmail || undefined,
      brandName: 'Mandate Control Plane',
      idempotencyKey: idempotencyKey('order', request.id),
    });

    const settlement: Settlement = {
      rail: 'ORDER_AUTHORIZE',
      simulated: Boolean(order.simulated),
      status: order.status,
      paypalId: order.id,
      approvalUrl: approvalUrl(order),
      raw: order,
      at: new Date().toISOString(),
    };

    return patchRequest(request, { status: 'AWAITING_BUYER_APPROVAL', rail: 'ORDER_AUTHORIZE', settlement }, {
      type: 'BUYER_APPROVAL_REQUIRED',
      actor: 'paypal',
      summary: `PayPal order ${order.id} created - awaiting buyer approval at PayPal${settlement.simulated ? ' [SIMULATED]' : ''}`,
      data: { settlement, approvalUrl: settlement.approvalUrl },
    });
  } catch (err) {
    const settlement: Settlement = {
      rail: 'ORDER_AUTHORIZE',
      simulated: !config.paypal.live,
      status: 'ERROR',
      error: err instanceof PayPalError ? err.summary : (err as Error).message,
      raw: err instanceof PayPalError ? err.toJSON() : undefined,
      at: new Date().toISOString(),
    };
    return patchRequest(request, { status: 'SETTLEMENT_FAILED', settlement }, {
      type: 'SETTLEMENT_FAILED',
      actor: 'paypal',
      summary: `Could not create the PayPal order: ${settlement.error}`,
      data: { settlement },
      accounting: { mandateId: request.mandateId, reservedDelta: -request.amountMinor },
    });
  }
}

/**
 * Rail 2 step 2: the buyer came back from PayPal. Place the authorization
 * hold, then capture it.
 */
export async function completeBuyerApproval(requestId: string): Promise<SpendRequest> {
  let request = getRequestOrThrow(requestId);

  if (request.status === 'SETTLED') return request;
  if (request.status !== 'AWAITING_BUYER_APPROVAL') {
    throw new DomainError('NOT_AWAITING_APPROVAL', `Spend request ${requestId} is ${request.status}`, 409);
  }
  const orderId = request.settlement?.paypalId;
  if (!orderId) throw new DomainError('NO_ORDER', `Spend request ${requestId} has no PayPal order attached`, 409);

  try {
    const authorized = await authorizeOrder(orderId, idempotencyKey('authorize', request.id), {
      amountMinor: request.amountMinor,
      currency: request.currency,
    });
    const authorizationId = firstAuthorizationId(authorized);
    if (!authorizationId) {
      throw new Error(`PayPal authorized order ${orderId} but returned no authorization id (status=${authorized.status})`);
    }

    ledger().append({
      type: 'AUTHORIZATION_CAPTURED',
      subject: request.id,
      actor: 'paypal',
      summary: `Authorization ${authorizationId} created on order ${orderId}`,
      data: { requestId: request.id, authorizationId, orderStatus: authorized.status },
    });

    const capture = await captureAuthorization({
      authorizationId,
      amountMinor: request.amountMinor,
      currency: request.currency,
      noteToPayer: `Approved spend under mandate ${request.mandateId}`,
      invoiceId: request.id,
      idempotencyKey: idempotencyKey('capture', request.id),
    });

    const settlement: Settlement = {
      ...(request.settlement as Settlement),
      rail: 'ORDER_AUTHORIZE',
      simulated: Boolean(capture.simulated),
      status: capture.status,
      authorizationId,
      captureId: capture.id,
      raw: capture,
      at: new Date().toISOString(),
    };

    return patchRequest(request, { status: 'SETTLED', settlement }, {
      type: 'SETTLEMENT_SUCCEEDED',
      actor: 'paypal',
      summary: `Captured ${format(request.amountMinor, request.currency)} - capture ${capture.id} (${capture.status})${settlement.simulated ? ' [SIMULATED]' : ''}`,
      data: { settlement },
      accounting: {
        mandateId: request.mandateId,
        reservedDelta: -request.amountMinor,
        spentDelta: request.amountMinor,
      },
    });
  } catch (err) {
    const settlement: Settlement = {
      ...(request.settlement as Settlement),
      status: 'ERROR',
      error: err instanceof PayPalError ? err.summary : (err as Error).message,
      at: new Date().toISOString(),
    };
    return patchRequest(request, { status: 'SETTLEMENT_FAILED', settlement }, {
      type: 'SETTLEMENT_FAILED',
      actor: 'paypal',
      summary: `Authorize/capture failed: ${settlement.error}`,
      data: { settlement },
      accounting: { mandateId: request.mandateId, reservedDelta: -request.amountMinor },
    });
  }
}

/** The buyer abandoned PayPal checkout, or an operator cancelled the hold. */
export async function cancelBuyerApproval(requestId: string, reason = 'Buyer cancelled at PayPal'): Promise<SpendRequest> {
  const request = getRequestOrThrow(requestId);
  if (!['AWAITING_BUYER_APPROVAL', 'PENDING_HUMAN', 'APPROVED'].includes(request.status)) {
    return request;
  }

  // If a hold was already placed, release it so the buyer's funds are freed.
  if (request.settlement?.authorizationId) {
    try {
      await voidAuthorization(request.settlement.authorizationId, idempotencyKey('void', request.id));
      ledger().append({
        type: 'AUTHORIZATION_VOIDED',
        subject: request.id,
        actor: 'control-plane',
        summary: `Authorization ${request.settlement.authorizationId} voided`,
        data: { requestId: request.id, authorizationId: request.settlement.authorizationId },
      });
    } catch (err) {
      ledger().append({
        type: 'SETTLEMENT_FAILED',
        subject: request.id,
        actor: 'paypal',
        summary: `Could not void authorization: ${(err as Error).message}`,
        data: { requestId: request.id },
      });
    }
  }

  return patchRequest(request, { status: 'CANCELLED' }, {
    type: 'DECISION_APPLIED',
    actor: 'buyer',
    summary: `Cancelled: ${reason}`,
    data: { reason },
    accounting: { mandateId: request.mandateId, reservedDelta: -request.amountMinor },
  });
}

/**
 * Refund a settled capture. Only the Orders rail can be refunded through the
 * API; a completed payout has to be recovered out of band, and we say so
 * plainly rather than pretending to have reversed it.
 */
export async function refundRequest(requestId: string, raw: unknown): Promise<SpendRequest> {
  const input = RefundInput.parse(raw);
  const request = getRequestOrThrow(requestId);

  if (request.status !== 'SETTLED') {
    throw new DomainError('NOT_SETTLED', `Only a settled request can be refunded; ${requestId} is ${request.status}`, 409);
  }
  const captureId = request.settlement?.captureId;
  if (!captureId) {
    throw new DomainError(
      'REFUND_UNSUPPORTED_FOR_RAIL',
      'This spend settled through PayPal Payouts, which has no refund API. Recover it from the recipient directly, or use the Orders rail (escalated spends) when reversibility matters.',
      409,
    );
  }

  const amountMinor = input.amount === undefined ? request.amountMinor : toMinor(input.amount, request.currency);
  if (amountMinor > request.amountMinor) {
    throw new DomainError('REFUND_EXCEEDS_CAPTURE', `Cannot refund more than the ${format(request.amountMinor, request.currency)} captured`);
  }

  const refund = await refundCapture({
    captureId,
    amountMinor: amountMinor === request.amountMinor ? undefined : amountMinor,
    currency: request.currency,
    noteToPayer: input.reason,
    invoiceId: request.id,
    idempotencyKey: idempotencyKey('refund', request.id, amountMinor),
  });

  const settlement: Settlement = {
    ...(request.settlement as Settlement),
    refundId: refund.id,
    status: `REFUNDED:${refund.status}`,
    at: new Date().toISOString(),
  };

  return patchRequest(request, { status: 'REFUNDED', settlement }, {
    type: 'PAYMENT_REFUNDED',
    actor: 'operator',
    summary: `Refunded ${format(amountMinor, request.currency)} - refund ${refund.id} (${refund.status})`,
    data: { settlement, refundedMinor: amountMinor, reason: input.reason },
    accounting: {
      mandateId: request.mandateId,
      spentDelta: -amountMinor,
      refundedDelta: amountMinor,
    },
  });
}

/** Re-poll PayPal for the current state of a payout batch. */
export async function syncSettlement(requestId: string): Promise<SpendRequest> {
  const request = getRequestOrThrow(requestId);
  const batchId = request.settlement?.paypalId;
  if (request.rail !== 'PAYOUT' || !batchId) return request;

  const res = await getPayout(batchId);
  const status = res.batch_header?.batch_status ?? 'UNKNOWN';
  if (status === request.settlement?.status) return request;

  const settlement: Settlement = {
    ...(request.settlement as Settlement),
    status,
    raw: res,
    at: new Date().toISOString(),
  };

  return patchRequest(request, { settlement }, {
    type: 'WEBHOOK_RECEIVED',
    actor: 'paypal',
    summary: `Payout batch ${batchId} is now ${status}`,
    data: { settlement, polled: true },
  });
}

export function listPending(): SpendRequest[] {
  return ledger().listRequests({ status: 'PENDING_HUMAN' });
}

/** Catalog search exposed to the agent and the UI. */
export { search as searchCatalog };
