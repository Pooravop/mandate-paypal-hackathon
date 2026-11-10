import { config, posture } from '../config.ts';
import { ledger } from '../ledger/ledger.ts';
import { PayPalError, accessToken, grantedScopes, request } from '../paypal/client.ts';
import { receiverIsPlaceholder, merchants } from '../catalog.ts';
import { getProvider } from '../ai/index.ts';
import { orderAmount } from '../util/money.ts';

/**
 * Preflight diagnostics.
 *
 * Setting up a PayPal sandbox app has several independent ways to go subtly
 * wrong -- wrong environment for the credentials, a missing Payouts scope, a
 * receiver email that is not a real sandbox account -- and each one surfaces
 * much later as an opaque API error in the middle of a payment. This checks
 * every one of them up front and says exactly what to do about each failure.
 */

type Status = 'ok' | 'warn' | 'fail' | 'skip';

const results: Array<{ status: Status; title: string; detail: string; fix?: string }> = [];

function record(status: Status, title: string, detail: string, fix?: string): void {
  results.push({ status, title, detail, fix });
}

async function checkPayPalCredentials(): Promise<boolean> {
  if (!config.paypal.live) {
    record(
      'warn',
      'PayPal credentials',
      'PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET are not set, so every payment will be simulated locally.',
      'Create a sandbox app at https://developer.paypal.com/dashboard/applications/sandbox, then copy .env.example to .env and paste in the client id and secret.',
    );
    return false;
  }

  try {
    await accessToken();
    record('ok', 'PayPal credentials', `Authenticated against ${config.paypal.baseUrl} (${config.paypal.env}).`);
  } catch (err) {
    const message = err instanceof PayPalError ? err.summary : (err as Error).message;
    record(
      'fail',
      'PayPal credentials',
      message,
      'Check that the client id and secret come from the same app, and that PAYPAL_ENV matches where that app lives (sandbox credentials are rejected by the live API and vice versa).',
    );
    return false;
  }

  const scopes = await grantedScopes();
  const needPayouts = scopes.some((s) => s.includes('payments/payouts'));
  const needPayment = scopes.some((s) => s.includes('services/payments/payment') || s.includes('payments/payment'));

  if (needPayouts) {
    record('ok', 'Payouts scope', 'The app is granted https://uri.paypal.com/payments/payouts, so autonomous settlement will work.');
  } else {
    record(
      'warn',
      'Payouts scope',
      'The access token does not list a payouts scope. Autonomous settlement may be rejected with NOT_AUTHORIZED.',
      'In the developer dashboard open your sandbox app and make sure "Payouts" is enabled under Features, then regenerate nothing - the scope is picked up on the next token request.',
    );
  }

  if (needPayment) {
    record('ok', 'Payments scope', 'The app can create and capture orders, so the human-approval rail will work.');
  } else {
    record('warn', 'Payments scope', 'No payments scope listed on the token; creating orders may fail.', 'Enable "Accept payments" on the sandbox app.');
  }

  record('ok', 'Granted scopes', scopes.length ? scopes.join('\n                   ') : '(none reported)');
  return true;
}

async function checkOrderCreation(): Promise<void> {
  try {
    // Creating an order moves no money; nothing is captured here.
    const order = await request<{ id: string; status: string; links?: Array<{ rel: string; href: string }> }>({
      method: 'POST',
      path: '/v2/checkout/orders',
      body: {
        intent: 'AUTHORIZE',
        purchase_units: [{ description: 'Mandate preflight check', amount: orderAmount(100, config.currency) }],
        payment_source: {
          paypal: {
            experience_context: {
              brand_name: 'Mandate Control Plane',
              shipping_preference: 'NO_SHIPPING',
              user_action: 'PAY_NOW',
              return_url: `${config.publicUrl}/api/paypal/return`,
              cancel_url: `${config.publicUrl}/api/paypal/cancel`,
            },
          },
        },
      },
      idempotencyKey: `doctor-${Date.now()}`,
    });
    const approve = order.links?.find((l) => l.rel === 'approve' || l.rel === 'payer-action');
    record(
      'ok',
      'Orders API (human-approval rail)',
      `Created test order ${order.id} (${order.status}). Nothing was captured.${approve ? `\n                   Approval URL works: ${approve.href}` : ''}`,
    );
  } catch (err) {
    const message = err instanceof PayPalError ? err.summary : (err as Error).message;
    record('fail', 'Orders API (human-approval rail)', message, 'Enable "Accept payments" on the sandbox app, and confirm the currency in CURRENCY is supported by your sandbox business account.');
  }
}

function checkReceiver(): void {
  if (receiverIsPlaceholder()) {
    record(
      'fail',
      'Payout receiver',
      `Merchants are pointing at the placeholder address "${merchants[0]?.receiver}". Real payouts will fail with RECEIVER_UNREGISTERED or be left unclaimed.`,
      'Set PAYPAL_PAYOUT_RECEIVER in .env to the email of a sandbox PERSONAL account from https://developer.paypal.com/dashboard/accounts.',
    );
  } else {
    record('ok', 'Payout receiver', `Merchants settle to ${merchants[0]?.receiver}.`);
  }
}

function checkWebhook(): void {
  if (!config.paypal.webhookId) {
    record(
      'warn',
      'Webhook verification',
      'PAYPAL_WEBHOOK_ID is not set. Incoming webhooks are still recorded in the audit ledger, but their signatures cannot be verified and they will not be acted on.',
      'Create a webhook on your sandbox app pointing at <public-url>/api/paypal/webhook, then put the generated webhook id in PAYPAL_WEBHOOK_ID.',
    );
  } else {
    record('ok', 'Webhook verification', `Signatures will be verified against webhook id ${config.paypal.webhookId}.`);
  }
}

async function checkAi(): Promise<void> {
  const provider = getProvider();
  if (!provider) {
    record(
      'warn',
      'AI provider',
      'No LLM key configured. The deterministic built-in reasoner will adjudicate spends - the pipeline works, but intent judgement is lexical rather than semantic.',
      'Set ANTHROPIC_API_KEY (recommended) or OPENAI_API_KEY in .env. Any OpenAI-compatible endpoint works via OPENAI_BASE_URL.',
    );
    return;
  }

  try {
    const res = await provider.chat({
      system: 'Reply with exactly the word OK and nothing else.',
      messages: [{ role: 'user', text: 'ping' }],
      maxTokens: 16,
      temperature: 0,
    });
    const reply = res.text.trim().slice(0, 40) || '(empty)';
    record('ok', 'AI provider', `${provider.name} responded using ${provider.model}. Reply: "${reply}"`);
  } catch (err) {
    record(
      'fail',
      'AI provider',
      `${provider.name} (${provider.model}) could not be reached: ${(err as Error).message}`,
      'Check the API key and the model name. The control plane still runs: adjudication falls back to the built-in reasoner and fails closed to human review.',
    );
  }
}

function checkLedger(): void {
  const v = ledger().verify();
  if (v.valid) {
    record('ok', 'Audit ledger', `${v.length} events, hash chain intact. Head: ${v.headHash.slice(0, 16)}...`);
  } else {
    record(
      'fail',
      'Audit ledger',
      `Chain broken at event ${v.brokenAt?.seq}: ${v.brokenAt?.reason}`,
      `The log at ${ledger().filePath} has been modified since it was written. Investigate, or reset it with POST /api/ledger/reset if this is a scratch environment.`,
    );
  }
}

const ICONS: Record<Status, string> = { ok: '  OK  ', warn: ' WARN ', fail: ' FAIL ', skip: ' SKIP ' };

async function main(): Promise<void> {
  const p = posture();
  process.stdout.write('\nMandate preflight\n');
  process.stdout.write('='.repeat(72) + '\n');
  process.stdout.write(`PayPal posture : ${p.paypal.mode} (${p.paypal.env})\n`);
  process.stdout.write(`AI posture     : ${p.ai.mode} (${p.ai.model})\n`);
  process.stdout.write('='.repeat(72) + '\n\n');

  const authed = await checkPayPalCredentials();
  if (authed) {
    checkReceiver();
    await checkOrderCreation();
  } else {
    record('skip', 'Payout receiver', 'Skipped: no PayPal credentials to test against.');
    record('skip', 'Orders API (human-approval rail)', 'Skipped: no PayPal credentials to test against.');
  }
  checkWebhook();
  await checkAi();
  checkLedger();

  for (const r of results) {
    process.stdout.write(`[${ICONS[r.status]}] ${r.title}\n`);
    for (const line of r.detail.split('\n')) process.stdout.write(`         ${line}\n`);
    if (r.fix) process.stdout.write(`         -> ${r.fix}\n`);
    process.stdout.write('\n');
  }

  const fails = results.filter((r) => r.status === 'fail').length;
  const warns = results.filter((r) => r.status === 'warn').length;
  process.stdout.write('='.repeat(72) + '\n');
  if (fails > 0) {
    process.stdout.write(`${fails} check(s) failed, ${warns} warning(s). The app will still start, but fix the failures above for a full live demo.\n\n`);
    process.exitCode = 1;
  } else if (warns > 0) {
    process.stdout.write(`All critical checks passed with ${warns} warning(s). Everything above runs; warnings mark reduced fidelity.\n\n`);
  } else {
    process.stdout.write('All checks passed. Live PayPal sandbox payments and real AI adjudication are both wired up.\n\n');
  }
}

await main();
