import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { config, posture } from '../config.ts';
import { ledger } from '../ledger/ledger.ts';
import { categories, merchants, search } from '../catalog.ts';
import { availableMinor } from '../policy/engine.ts';
import { providerLabel } from '../ai/index.ts';
import { runAgent } from '../ai/agent.ts';
import { AgentChatInput } from '../service/schemas.ts';
import {
  DomainError,
  createMandate,
  getMandateOrThrow,
  listMandates,
  revokeMandate,
  updateMandate,
} from '../service/mandates.ts';
import { decideHuman, refundRequest, requestSpend, syncSettlement } from '../service/spend.ts';
import { PayPalError, grantedScopes } from '../paypal/client.ts';
import { receiverIsPlaceholder } from '../catalog.ts';
import { seedDemo } from '../service/demo.ts';
import type { LedgerEventType } from '../types.ts';

export const api = Router();

/**
 * Optional shared-secret gate on everything that can move money or alter
 * authority. Off by default so `npm run dev` just works; set OPERATOR_TOKEN
 * before exposing this beyond localhost.
 */
function requireOperator(req: Request, res: Response, next: NextFunction): void {
  if (!config.operatorToken) return next();
  const header = req.header('authorization') ?? '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : req.header('x-operator-token') ?? '';
  if (bearer !== config.operatorToken) {
    res.status(401).json({ error: 'UNAUTHORIZED', message: 'A valid operator token is required for this endpoint.' });
    return;
  }
  next();
}

/** Turns domain, validation and PayPal errors into consistent JSON. */
function fail(res: Response, err: unknown): void {
  if (err instanceof z.ZodError) {
    res.status(400).json({
      error: 'VALIDATION_FAILED',
      message: err.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; '),
      issues: err.issues,
    });
    return;
  }
  if (err instanceof DomainError) {
    res.status(err.statusCode).json({ error: err.code, message: err.message });
    return;
  }
  if (err instanceof PayPalError) {
    res.status(502).json({ error: 'PAYPAL_ERROR', message: err.summary, paypal: err.toJSON() });
    return;
  }
  const e = err as Error;
  res.status(500).json({ error: 'INTERNAL', message: e.message });
}

const handle = (fn: (req: Request, res: Response) => Promise<void> | void) =>
  async (req: Request, res: Response): Promise<void> => {
    try {
      await fn(req, res);
    } catch (err) {
      fail(res, err);
    }
  };

// --- Posture and metadata ------------------------------------------------

api.get('/health', (_req, res) => {
  const v = ledger().verify();
  res.json({ ok: true, ledgerEvents: v.length, ledgerValid: v.valid, uptimeSeconds: Math.round(process.uptime()) });
});

api.get(
  '/config',
  handle(async (_req, res) => {
    const p = posture();
    let scopes: string[] = [];
    let credentialError: string | undefined;
    if (config.paypal.live) {
      try {
        scopes = await grantedScopes();
      } catch (err) {
        credentialError = err instanceof PayPalError ? err.summary : (err as Error).message;
      }
    }
    res.json({
      posture: p,
      paypal: {
        env: config.paypal.env,
        baseUrl: config.paypal.baseUrl,
        live: config.paypal.live,
        webhookConfigured: Boolean(config.paypal.webhookId),
        receiverIsPlaceholder: receiverIsPlaceholder(),
        scopes,
        credentialError,
      },
      ai: { provider: config.ai.provider, label: providerLabel() },
      currency: config.currency,
      categories: categories(),
      merchants,
      operatorTokenRequired: Boolean(config.operatorToken),
      publicUrl: config.publicUrl,
    });
  }),
);

api.get('/catalog', (req, res) => {
  const query = typeof req.query.query === 'string' ? req.query.query : undefined;
  const category = typeof req.query.category === 'string' ? req.query.category : undefined;
  res.json({ items: search({ query, category, limit: 100 }), merchants, categories: categories() });
});

// --- Mandates ------------------------------------------------------------

api.get('/mandates', (_req, res) => {
  res.json({ mandates: listMandates() });
});

api.post('/mandates', requireOperator, handle((req, res) => {
  const mandate = createMandate(req.body);
  res.status(201).json({ mandate: { ...mandate, availableMinor: availableMinor(mandate) } });
}));

api.get('/mandates/:id', handle((req, res) => {
  const mandate = getMandateOrThrow(req.params.id as string);
  res.json({
    mandate: { ...mandate, availableMinor: availableMinor(mandate) },
    requests: ledger().listRequests({ mandateId: mandate.id, limit: 100 }),
  });
}));

api.patch('/mandates/:id', requireOperator, handle((req, res) => {
  const mandate = updateMandate(req.params.id as string, req.body);
  res.json({ mandate: { ...mandate, availableMinor: availableMinor(mandate) } });
}));

api.post('/mandates/:id/revoke', requireOperator, handle((req, res) => {
  const mandate = revokeMandate(req.params.id as string, req.body ?? {});
  res.json({ mandate: { ...mandate, availableMinor: availableMinor(mandate) } });
}));

// --- Spend requests ------------------------------------------------------

api.get('/requests', (req, res) => {
  const mandateId = typeof req.query.mandateId === 'string' ? req.query.mandateId : undefined;
  const status = typeof req.query.status === 'string' ? (req.query.status as never) : undefined;
  res.json({ requests: ledger().listRequests({ mandateId, status, limit: 200 }) });
});

api.get('/requests/:id', handle((req, res) => {
  const request = ledger().getRequest(req.params.id as string);
  if (!request) throw new DomainError('REQUEST_NOT_FOUND', `No spend request with id ${req.params.id}`, 404);
  res.json({ request, events: ledger().list({ subject: request.id, limit: 100 }) });
}));

/**
 * The programmatic spend endpoint - this is the API an external agent calls.
 * Deliberately the same code path the in-process agent and the MCP server use,
 * so there is exactly one gate to reason about.
 */
api.post('/requests', handle(async (req, res) => {
  const request = await requestSpend(req.body);
  res.status(201).json({ request });
}));

api.post('/requests/:id/decision', requireOperator, handle(async (req, res) => {
  const request = await decideHuman(req.params.id as string, req.body ?? {});
  res.json({ request });
}));

api.post('/requests/:id/refund', requireOperator, handle(async (req, res) => {
  const request = await refundRequest(req.params.id as string, req.body ?? {});
  res.json({ request });
}));

api.post('/requests/:id/sync', handle(async (req, res) => {
  const request = await syncSettlement(req.params.id as string);
  res.json({ request });
}));

// --- Audit ledger --------------------------------------------------------

api.get('/ledger', (req, res) => {
  const limit = Math.min(1000, Number(req.query.limit ?? 200) || 200);
  const subject = typeof req.query.subject === 'string' ? req.query.subject : undefined;
  const type = typeof req.query.type === 'string' ? (req.query.type as LedgerEventType) : undefined;
  res.json({
    events: ledger().list({ limit, subject, type }),
    total: ledger().size(),
    head: ledger().head()?.hash,
    file: ledger().filePath,
  });
});

api.get('/ledger/verify', (_req, res) => {
  res.json(ledger().verify());
});

api.post('/ledger/reset', requireOperator, handle((_req, res) => {
  if (!config.allowLedgerReset) {
    throw new DomainError('RESET_DISABLED', 'Ledger reset is disabled. Set ALLOW_LEDGER_RESET=true to enable it.', 403);
  }
  ledger().reset();
  res.json({ ok: true, events: ledger().size() });
}));

// --- Live event stream ---------------------------------------------------

/**
 * Server-sent events so the dashboard reflects agent activity as it happens.
 * A heartbeat keeps intermediaries from closing an idle connection.
 */
api.get('/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(`event: hello\ndata: ${JSON.stringify({ total: ledger().size() })}\n\n`);

  const onEvent = (event: unknown) => {
    res.write(`event: ledger\ndata: ${JSON.stringify(event)}\n\n`);
  };
  const onReset = () => res.write(`event: reset\ndata: {}\n\n`);

  ledger().on('event', onEvent);
  ledger().on('reset', onReset);
  const heartbeat = setInterval(() => res.write(': keepalive\n\n'), 25000);

  req.on('close', () => {
    clearInterval(heartbeat);
    ledger().off('event', onEvent);
    ledger().off('reset', onReset);
  });
});

// --- Agent console -------------------------------------------------------

/**
 * Streams the agent's reasoning, tool calls and tool results as they occur.
 * Uses POST + SSE (not EventSource) because the request carries a body.
 */
api.post('/agent/chat', handle(async (req, res) => {
  const input = AgentChatInput.parse(req.body);
  // Validate the mandate before opening the stream so a bad id is a clean 404.
  getMandateOrThrow(input.mandateId);

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const send = (type: string, payload: unknown) => {
    res.write(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`);
  };

  try {
    const result = await runAgent({
      mandateId: input.mandateId,
      message: input.message,
      history: input.history,
      onStep: (step) => send('step', step),
    });
    send('done', {
      reply: result.reply,
      provider: result.provider,
      model: result.model,
      spendRequestIds: result.spendRequests.map((r) => r.id),
    });
  } catch (err) {
    send('error', { message: (err as Error).message });
  } finally {
    res.end();
  }
}));

// --- Demo seeding --------------------------------------------------------

api.post('/demo/seed', requireOperator, handle((_req, res) => {
  res.json(seedDemo());
}));
