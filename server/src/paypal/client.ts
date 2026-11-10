import { config } from '../config.ts';

/**
 * Minimal, dependency-free PayPal REST transport.
 *
 * Deliberately hand-rolled rather than pulled from an SDK: the control plane
 * needs exact control over idempotency keys and it needs PayPal's `debug_id`
 * preserved on every failure, because that is the only identifier PayPal
 * support can act on. Most SDK wrappers throw it away.
 */

export interface PayPalErrorDetail {
  issue?: string;
  description?: string;
  field?: string;
  value?: string;
}

export class PayPalError extends Error {
  readonly httpStatus: number;
  readonly paypalName: string;
  readonly debugId: string | undefined;
  readonly details: PayPalErrorDetail[];
  readonly raw: unknown;

  constructor(args: {
    httpStatus: number;
    paypalName: string;
    message: string;
    debugId?: string;
    details?: PayPalErrorDetail[];
    raw?: unknown;
  }) {
    super(args.message);
    this.name = 'PayPalError';
    this.httpStatus = args.httpStatus;
    this.paypalName = args.paypalName;
    this.debugId = args.debugId;
    this.details = args.details ?? [];
    this.raw = args.raw;
  }

  /** Operator-facing one-liner that keeps the debug_id attached. */
  get summary(): string {
    const issues = this.details
      .map((d) => [d.issue, d.field, d.description].filter(Boolean).join(' '))
      .filter(Boolean)
      .join('; ');
    const parts = [`${this.paypalName} (HTTP ${this.httpStatus})`, this.message];
    if (issues) parts.push(issues);
    if (this.debugId) parts.push(`debug_id=${this.debugId}`);
    return parts.join(' - ');
  }

  toJSON() {
    return {
      error: this.paypalName,
      message: this.message,
      httpStatus: this.httpStatus,
      debugId: this.debugId,
      details: this.details,
    };
  }
}

interface CachedToken {
  accessToken: string;
  expiresAtMs: number;
  scopes: string[];
}

let tokenCache: CachedToken | undefined;
let inFlightToken: Promise<CachedToken> | undefined;

function assertConfigured(): void {
  if (!config.paypal.live) {
    throw new PayPalError({
      httpStatus: 500,
      paypalName: 'NOT_CONFIGURED',
      message: 'PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET are not set. Copy .env.example to .env and add your sandbox app credentials.',
    });
  }
}

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function toPayPalError(httpStatus: number, body: unknown, fallback: string): PayPalError {
  const b = (body ?? {}) as Record<string, any>;
  // PayPal is not consistent here: OAuth errors use {error, error_description},
  // the REST APIs use {name, message, details[], debug_id}.
  const paypalName = b.name ?? b.error ?? `HTTP_${httpStatus}`;
  const message = b.message ?? b.error_description ?? (typeof body === 'string' && body ? body : fallback);
  return new PayPalError({
    httpStatus,
    paypalName,
    message,
    debugId: b.debug_id,
    details: Array.isArray(b.details) ? b.details : [],
    raw: body,
  });
}

/**
 * Client-credentials access token, cached until shortly before expiry.
 * Concurrent callers share one in-flight request instead of stampeding
 * the token endpoint.
 */
export async function accessToken(): Promise<string> {
  assertConfigured();

  if (tokenCache && tokenCache.expiresAtMs > Date.now()) return tokenCache.accessToken;
  if (inFlightToken) return (await inFlightToken).accessToken;

  inFlightToken = (async (): Promise<CachedToken> => {
    const basic = Buffer.from(`${config.paypal.clientId}:${config.paypal.clientSecret}`).toString('base64');
    const res = await fetch(`${config.paypal.baseUrl}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: 'grant_type=client_credentials',
      signal: AbortSignal.timeout(config.paypal.timeoutMs),
    });

    const body = await readBody(res);
    if (!res.ok) {
      if (res.status === 401) {
        throw new PayPalError({
          httpStatus: 401,
          paypalName: 'INVALID_CLIENT',
          message:
            'PayPal rejected the client credentials. Check that PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET belong to the same app and that PAYPAL_ENV matches (sandbox credentials do not work against live).',
          raw: body,
        });
      }
      throw toPayPalError(res.status, body, 'Failed to obtain a PayPal access token');
    }

    const b = body as { access_token: string; expires_in: number; scope?: string };
    // Refresh 60s early so a token never expires mid-request.
    const ttlMs = Math.max(30, (b.expires_in ?? 32400) - 60) * 1000;
    return {
      accessToken: b.access_token,
      expiresAtMs: Date.now() + ttlMs,
      scopes: (b.scope ?? '').split(' ').filter(Boolean),
    };
  })();

  try {
    tokenCache = await inFlightToken;
    return tokenCache.accessToken;
  } finally {
    inFlightToken = undefined;
  }
}

/** Scopes granted to the current app - used by `npm run doctor`. */
export async function grantedScopes(): Promise<string[]> {
  await accessToken();
  return tokenCache?.scopes ?? [];
}

export interface RequestOptions {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  path: string;
  body?: unknown;
  /**
   * Sent as PayPal-Request-Id. PayPal retains these for 30 days, so replaying a
   * request with the same key will not move money twice. Every write path in
   * Mandate derives this key deterministically from the spend-request id.
   */
  idempotencyKey?: string;
  /** `return=representation` asks PayPal for the full resource, not just id+status. */
  representation?: boolean;
  headers?: Record<string, string>;
}

export async function request<T = unknown>(opts: RequestOptions): Promise<T> {
  const token = await accessToken();
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
    ...opts.headers,
  };
  if (opts.idempotencyKey) headers['PayPal-Request-Id'] = opts.idempotencyKey;
  if (opts.representation) headers['Prefer'] = 'return=representation';

  let res: Response;
  try {
    res = await fetch(`${config.paypal.baseUrl}${opts.path}`, {
      method: opts.method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: AbortSignal.timeout(config.paypal.timeoutMs),
    });
  } catch (err) {
    const e = err as Error;
    throw new PayPalError({
      httpStatus: 0,
      paypalName: e.name === 'TimeoutError' ? 'NETWORK_TIMEOUT' : 'NETWORK_ERROR',
      message: `${opts.method} ${opts.path} could not reach PayPal: ${e.message}`,
    });
  }

  const body = await readBody(res);

  // 401 can mean a token revoked server-side. Drop the cache so the next
  // attempt re-authenticates rather than looping on a dead token.
  if (res.status === 401) tokenCache = undefined;

  if (!res.ok) throw toPayPalError(res.status, body, `${opts.method} ${opts.path} failed`);
  return body as T;
}

/** Shape shared by every PayPal HATEOAS response. */
export interface PayPalLink {
  href: string;
  rel: string;
  method?: string;
}

export function findLink(links: PayPalLink[] | undefined, ...rels: string[]): string | undefined {
  if (!links) return undefined;
  for (const rel of rels) {
    const hit = links.find((l) => l.rel === rel);
    if (hit) return hit.href;
  }
  return undefined;
}

/** Clears the cached token. Used by tests and the doctor CLI. */
export function resetTokenCache(): void {
  tokenCache = undefined;
  inFlightToken = undefined;
}
