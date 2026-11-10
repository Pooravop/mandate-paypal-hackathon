import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.ts';
import type { ChatRequest, ChatResponse, LlmProvider, Msg, ToolUse } from './provider.ts';

/** Claude-backed provider. Default when ANTHROPIC_API_KEY is present. */
export class AnthropicProvider implements LlmProvider {
  readonly name = 'anthropic';
  readonly isModel = true;
  readonly model: string;
  private client: Anthropic;

  constructor(model = config.ai.model) {
    this.model = model;
    this.client = new Anthropic({ apiKey: config.ai.anthropicKey, timeout: config.ai.timeoutMs });
  }

  private toAnthropicMessages(messages: Msg[]): Anthropic.MessageParam[] {
    const out: Anthropic.MessageParam[] = [];
    for (const m of messages) {
      if (m.role === 'user') {
        out.push({ role: 'user', content: m.text });
        continue;
      }
      if (m.role === 'assistant') {
        const content: Anthropic.ContentBlockParam[] = [];
        if (m.text) content.push({ type: 'text', text: m.text });
        for (const t of m.toolUses ?? []) {
          content.push({ type: 'tool_use', id: t.id, name: t.name, input: t.input });
        }
        // An assistant turn with neither text nor tool calls is not a legal
        // message; skip it rather than let the API reject the whole request.
        if (content.length > 0) out.push({ role: 'assistant', content });
        continue;
      }
      // Anthropic carries tool results back as a user-role message.
      out.push({
        role: 'user',
        content: m.results.map((r) => ({
          type: 'tool_result' as const,
          tool_use_id: r.id,
          content: r.output,
          is_error: r.isError ?? false,
        })),
      });
    }
    return out;
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const res = await this.client.messages.create({
      model: this.model,
      max_tokens: req.maxTokens ?? config.ai.maxTokens,
      system: req.system,
      messages: this.toAnthropicMessages(req.messages),
      ...(req.temperature === undefined ? {} : { temperature: req.temperature }),
      ...(req.tools && req.tools.length > 0
        ? {
            tools: req.tools.map((t) => ({
              name: t.name,
              description: t.description,
              input_schema: t.parameters as Anthropic.Tool.InputSchema,
            })),
          }
        : {}),
    });

    let text = '';
    const toolUses: ToolUse[] = [];
    for (const block of res.content) {
      if (block.type === 'text') text += block.text;
      else if (block.type === 'tool_use') {
        toolUses.push({ id: block.id, name: block.name, input: (block.input ?? {}) as Record<string, unknown> });
      }
    }

    const stopReason: ChatResponse['stopReason'] =
      res.stop_reason === 'tool_use' ? 'tool_use' : res.stop_reason === 'max_tokens' ? 'max_tokens' : res.stop_reason === 'end_turn' ? 'end' : 'other';

    return {
      text,
      toolUses,
      stopReason,
      usage: { inputTokens: res.usage?.input_tokens, outputTokens: res.usage?.output_tokens },
    };
  }
}
