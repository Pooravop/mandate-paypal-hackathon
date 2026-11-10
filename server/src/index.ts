import express from 'express';
import cors from 'cors';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, posture } from './config.ts';
import { ledger } from './ledger/ledger.ts';
import { api } from './routes/api.ts';
import { paypalRoutes } from './routes/paypal.ts';
import { receiverIsPlaceholder } from './catalog.ts';

const app = express();

app.disable('x-powered-by');
app.use(cors({ origin: [config.webOrigin, config.publicUrl], credentials: false }));

// The webhook router mounts its own express.raw() parser, so it must be
// registered before the global JSON parser gets a chance to consume the body.
app.use('/api/paypal', paypalRoutes);

app.use(express.json({ limit: '1mb' }));
app.use('/api', api);

// Serve the built frontend when it exists, so `npm run build && npm start`
// gives a single-process deployment with no separate static host.
// fileURLToPath, not URL.pathname: the latter leaves percent-escapes in place,
// so any directory with a space in its name resolves to a path that does not exist.
const webDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'dist');
if (fs.existsSync(webDist)) {
  app.use(express.static(webDist));
  app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(path.join(webDist, 'index.html')));
}

app.use((_req, res) => {
  res.status(404).json({ error: 'NOT_FOUND', message: 'No such endpoint' });
});

const server = app.listen(config.port, () => {
  const p = posture();
  const chain = ledger().verify();

  const line = (label: string, value: string) => `  ${label.padEnd(16)} ${value}`;
  const banner = [
    '',
    '  Mandate - payment control plane for AI agents',
    '  ' + '-'.repeat(52),
    line('API', `http://localhost:${config.port}`),
    line('Web UI', config.webOrigin),
    line('PayPal', `${p.paypal.mode.toUpperCase()} - ${p.paypal.detail}`),
    line('AI', `${p.ai.mode.toUpperCase()} - ${p.ai.detail}`),
    line('Audit ledger', `${chain.length} events, chain ${chain.valid ? 'valid' : 'INVALID'}`),
    line('Ledger file', ledger().filePath),
    '',
  ];

  const warnings: string[] = [];
  if (!config.paypal.live) {
    warnings.push('No PayPal credentials: payments are simulated locally. Copy .env.example to .env and add your sandbox app credentials to move real sandbox money.');
  } else if (receiverIsPlaceholder()) {
    warnings.push('PAYPAL_PAYOUT_RECEIVER is not set, so merchants point at a placeholder address and payouts will fail. Set it to your sandbox personal account email.');
  }
  if (!config.paypal.webhookId && config.paypal.live) {
    warnings.push('PAYPAL_WEBHOOK_ID is not set: incoming webhooks will be recorded but their signatures cannot be verified.');
  }
  if (config.ai.provider === 'builtin') {
    warnings.push('No LLM key: the built-in deterministic reasoner is adjudicating spends. Set ANTHROPIC_API_KEY for real model reasoning.');
  }
  if (!config.operatorToken) {
    warnings.push('OPERATOR_TOKEN is empty: mutating endpoints are unauthenticated. Fine for localhost, not for a public deployment.');
  }

  process.stdout.write(banner.join('\n') + '\n');
  if (warnings.length > 0) {
    process.stdout.write(warnings.map((w) => `  ! ${w}`).join('\n') + '\n\n');
  }
});

function shutdown(signal: string): void {
  process.stdout.write(`\n${signal} received, shutting down.\n`);
  server.close(() => process.exit(0));
  // Do not hang forever on a stuck keep-alive connection.
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
