import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Minimal .env loader.
 *
 * Deliberately not a dependency: the file format we need is a handful of
 * KEY=value lines, and doing it here means the env is loaded identically by
 * the server, the CLIs and the MCP stdio entry point without every npm script
 * having to remember the right runtime flag.
 *
 * Real environment variables always win, so a shell export or a container
 * secret is never silently overridden by a stale checked-out .env.
 */

function parse(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim().replace(/^export\s+/, '');
    if (!key) continue;
    let value = line.slice(eq + 1).trim();
    // Strip matching quotes, and only then honour escapes inside them.
    if ((value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
        (value.startsWith("'") && value.endsWith("'") && value.length > 1)) {
      const quote = value[0];
      value = value.slice(1, -1);
      if (quote === '"') value = value.replace(/\\n/g, '\n').replace(/\\"/g, '"');
    } else {
      // Unquoted values end at an inline comment.
      const hash = value.indexOf(' #');
      if (hash !== -1) value = value.slice(0, hash).trim();
    }
    out[key] = value;
  }
  return out;
}

let loadedFrom: string | undefined;

/** Loads the first .env found walking up from the server directory. */
export function loadEnv(): void {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    process.env.ENV_FILE,
    path.resolve(here, '..', '..', '..', '.env'), // repo root
    path.resolve(here, '..', '..', '.env'), // server/
  ].filter((p): p is string => Boolean(p));

  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    try {
      const vars = parse(fs.readFileSync(file, 'utf8'));
      for (const [k, v] of Object.entries(vars)) {
        if (process.env[k] === undefined) process.env[k] = v;
      }
      loadedFrom = file;
      return;
    } catch {
      /* an unreadable .env is not worth crashing over */
    }
  }
}

export function envFile(): string | undefined {
  return loadedFrom;
}

export { parse as parseEnv };
