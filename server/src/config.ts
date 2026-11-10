/**
 * Central runtime configuration.
 *
 * Mandate runs in three escalating fidelity levels and reports which one it is in
 * so judges / operators are never confused about whether money actually moved:
 *
 *   paypal.live   = true  -> real calls against the PayPal sandbox REST API
 *   ai.provider   != 'builtin' -> real LLM calls for agent + adjudicator reasoning
 *
 * Nothing silently degrades: /api/config exposes the exact posture to the UI.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from './util/env.ts';

// Must run before any process.env read below.
loadEnv();

const serverDir = path.dirname(fileURLToPath(import.meta.url));
/** Repo-root-relative default so `data/` sits next to package.json, not inside src/. */
const defaultDataDir = path.resolve(serverDir, '..', '..', 'data');

export type AiProvider = 'anthropic' | 'openai' | 'builtin';

function str(name: string, fallback = ''): string {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

function num(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function bool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

const paypalEnv = str('PAYPAL_ENV', 'sandbox').toLowerCase() === 'live' ? 'live' : 'sandbox';
const clientId = str('PAYPAL_CLIENT_ID');
const clientSecret = str('PAYPAL_CLIENT_SECRET');

function resolveAiProvider(): AiProvider {
  const explicit = str('AI_PROVIDER').toLowerCase();
  if (explicit === 'anthropic' || explicit === 'openai' || explicit === 'builtin') return explicit;
  if (str('ANTHROPIC_API_KEY')) return 'anthropic';
  if (str('OPENAI_API_KEY')) return 'openai';
  return 'builtin';
}

const aiProvider = resolveAiProvider();

export const config = {
  port: num('PORT', 8787),
  webOrigin: str('WEB_ORIGIN', 'http://localhost:5173'),
  publicUrl: str('PUBLIC_URL', `http://localhost:${num('PORT', 8787)}`),
  dataDir: path.resolve(str('DATA_DIR', defaultDataDir)),

  paypal: {
    env: paypalEnv as 'sandbox' | 'live',
    baseUrl: paypalEnv === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com',
    checkoutHost: paypalEnv === 'live' ? 'https://www.paypal.com' : 'https://www.sandbox.paypal.com',
    clientId,
    clientSecret,
    webhookId: str('PAYPAL_WEBHOOK_ID'),
    /** True when real credentials are present, so real network calls will be made. */
    live: Boolean(clientId && clientSecret),
    /** Merchant-of-record email for the sandbox business account receiving Orders-API funds. */
    payeeEmail: str('PAYPAL_PAYEE_EMAIL'),
    timeoutMs: num('PAYPAL_TIMEOUT_MS', 20000),
  },

  ai: {
    provider: aiProvider,
    anthropicKey: str('ANTHROPIC_API_KEY'),
    openaiKey: str('OPENAI_API_KEY'),
    openaiBaseUrl: str('OPENAI_BASE_URL', 'https://api.openai.com/v1'),
    model: str('AI_MODEL', aiProvider === 'anthropic' ? 'claude-sonnet-5-5' : 'gpt-4o-mini'),
    /** Adjudication is the safety-critical path; keep it cheap but capable. */
    adjudicatorModel: str('AI_ADJUDICATOR_MODEL', str('AI_MODEL', aiProvider === 'anthropic' ? 'claude-sonnet-5-5' : 'gpt-4o-mini')),
    maxTokens: num('AI_MAX_TOKENS', 2048),
    timeoutMs: num('AI_TIMEOUT_MS', 45000),
  },

  /** Default currency for seeded mandates and the catalog. */
  currency: str('CURRENCY', 'USD'),

  /** Require an operator token on mutating routes. Empty string disables the check. */
  operatorToken: str('OPERATOR_TOKEN'),

  /** Allow the audit ledger file to be reset via API (handy for repeated demos). */
  allowLedgerReset: bool('ALLOW_LEDGER_RESET', true),
} as const;

export function posture() {
  return {
    paypal: config.paypal.live
      ? { mode: 'live-api' as const, env: config.paypal.env, detail: `Real REST calls to ${config.paypal.baseUrl}` }
      : { mode: 'simulated' as const, env: config.paypal.env, detail: 'No PAYPAL_CLIENT_ID/SECRET set - PayPal calls are simulated locally' },
    ai: config.ai.provider === 'builtin'
      ? { mode: 'builtin' as const, provider: 'builtin', model: 'rule-based-reasoner', detail: 'No LLM key set - using the deterministic built-in reasoner' }
      : { mode: 'llm' as const, provider: config.ai.provider, model: config.ai.model, detail: `Live ${config.ai.provider} calls (${config.ai.model})` },
  };
}
