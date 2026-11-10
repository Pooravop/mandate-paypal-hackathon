/**
 * Provider-agnostic LLM interface.
 *
 * Mandate needs two distinct AI behaviours:
 *
 *   chat()  - a multi-turn tool-using loop, for the shopping agent that
 *             actually decides what to buy
 *   judge() - a single-shot call that must return strict JSON, for the
 *             adjudicator that decides whether a spend matches its mandate
 *
 * Both are expressed in a normalised message shape so the control plane does
 * not care which vendor is behind it. Three implementations exist: Anthropic,
 * any OpenAI-compatible endpoint, and a deterministic built-in reasoner used
 * when no API key is configured so the project is never a dead end for a
 * reviewer without credentials.
 */

export interface ToolSchema {
  name: string;
  description: string;
  /** JSON Schema for the tool input. */
  parameters: Record<string, unknown>;
}

export interface ToolUse {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResult {
  id: string;
  name: string;
  output: string;
  isError?: boolean;
}

export type Msg =
  | { role: 'user'; text: string }
  | { role: 'assistant'; text?: string; toolUses?: ToolUse[] }
  | { role: 'tool'; results: ToolResult[] };

export interface ChatRequest {
  system: string;
  messages: Msg[];
  tools?: ToolSchema[];
  maxTokens?: number;
  temperature?: number;
}

export interface ChatResponse {
  text: string;
  toolUses: ToolUse[];
  /** Vendor-reported stop reason, normalised to a few known strings. */
  stopReason: 'end' | 'tool_use' | 'max_tokens' | 'other';
  usage?: { inputTokens?: number; outputTokens?: number };
}

export interface LlmProvider {
  readonly name: string;
  readonly model: string;
  /** True when this provider makes real network calls to a model. */
  readonly isModel: boolean;
  chat(req: ChatRequest): Promise<ChatResponse>;
}

/**
 * Pull the first JSON object out of a model response.
 *
 * Models wrap JSON in prose or fences no matter how firmly you ask them not
 * to, and the adjudicator's output gates real payments, so parsing has to be
 * robust rather than optimistic. Falls back to brace-matching so a trailing
 * explanation after the object does not break it.
 */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    /* fall through to recovery strategies */
  }

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced?.[1]) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch {
      /* keep going */
    }
  }

  const start = trimmed.indexOf('{');
  if (start === -1) throw new Error(`No JSON object found in model output: ${trimmed.slice(0, 200)}`);

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < trimmed.length; i++) {
    const ch = trimmed[i] as string;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        const candidate = trimmed.slice(start, i + 1);
        return JSON.parse(candidate);
      }
    }
  }
  throw new Error(`Unbalanced JSON in model output: ${trimmed.slice(0, 200)}`);
}
