import { config } from '../config.ts';
import type { ChatRequest, ChatResponse, LlmProvider, Msg, ToolUse } from './provider.ts';

/**
 * Any OpenAI-compatible chat-completions endpoint.
 *
 * Written against raw fetch rather than the vendor SDK so the same code path
 * serves OpenAI, Groq, Together, OpenRouter, vLLM or a local Ollama build --
 * point OPENAI_BASE_URL wherever you like. That matters for a hackathon
 * judge who may want to run this entirely on their own hardware.
 */
export class OpenAiProvider implements LlmProvider {
  readonly name = 'openai';
  readonly isModel = true;
  readonly model: string;

  constructor(model = config.ai.model) {
    this.model = model;
  }

  private toOpenAiMessages(system: string, messages: Msg[]): Array<Record<string, unknown>> {
    const out: Array<Record<string, unknown>> = [{ role: 'system', content: system }];
    for (const m of messages) {
      if (m.role === 'user') {
        out.push({ role: 'user', content: m.text });
        continue;
      }
      if (m.role === 'assistant') {
        const msg: Record<string, unknown> = { role: 'assistant', content: m.text ?? null };
        if (m.toolUses && m.toolUses.length > 0) {
          msg.tool_calls = m.toolUses.map((t) => ({
            id: t.id,
            type: 'function',
            function: { name: t.name, arguments: JSON.stringify(t.input) },
          }));
        }
        out.push(msg);
        continue;
      }
      // Each tool result is its own message, keyed by tool_call_id.
      for (const r of m.results) {
        out.push({ role: 'tool', tool_call_id: r.id, content: r.output });
      }
    }
    return out;
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: this.toOpenAiMessages(req.system, req.messages),
      max_tokens: req.maxTokens ?? config.ai.maxTokens,
    };
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (req.tools && req.tools.length > 0) {
      body.tools = req.tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
      body.tool_choice = 'auto';
    }

    const res = await fetch(`${config.ai.openaiBaseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.ai.openaiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(config.ai.timeoutMs),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`OpenAI-compatible endpoint returned HTTP ${res.status}: ${text.slice(0, 400)}`);
    }

    const json = (await res.json()) as {
      choices?: Array<{
        message?: { content?: string | null; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> };
        finish_reason?: string;
      }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };

    const choice = json.choices?.[0];
    const toolUses: ToolUse[] = (choice?.message?.tool_calls ?? []).map((c) => {
      let input: Record<string, unknown> = {};
      try {
        input = JSON.parse(c.function.arguments || '{}') as Record<string, unknown>;
      } catch {
        // A malformed arguments blob must not crash the loop; the tool
        // executor will report the validation failure back to the model.
        input = { __malformed: c.function.arguments };
      }
      return { id: c.id, name: c.function.name, input };
    });

    const finish = choice?.finish_reason;
    const stopReason: ChatResponse['stopReason'] =
      finish === 'tool_calls' ? 'tool_use' : finish === 'length' ? 'max_tokens' : finish === 'stop' ? 'end' : 'other';

    return {
      text: choice?.message?.content ?? '',
      toolUses,
      stopReason,
      usage: { inputTokens: json.usage?.prompt_tokens, outputTokens: json.usage?.completion_tokens },
    };
  }
}
