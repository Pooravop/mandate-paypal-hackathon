import { config } from '../config.ts';
import { AnthropicProvider } from './anthropic.ts';
import { OpenAiProvider } from './openai.ts';
import type { LlmProvider } from './provider.ts';

let cached: LlmProvider | null | undefined;

/**
 * The active model provider, or null when none is configured.
 *
 * null is a first-class, supported state rather than an error: the adjudicator
 * and the agent each have a deterministic built-in path so the control plane
 * stays fully operable without an API key. Callers branch on null instead of
 * receiving a pretend model, which keeps the "is a real model reasoning about
 * this payment?" question honestly answerable at every layer.
 */
export function getProvider(): LlmProvider | null {
  if (cached !== undefined) return cached;
  try {
    if (config.ai.provider === 'anthropic' && config.ai.anthropicKey) cached = new AnthropicProvider();
    else if (config.ai.provider === 'openai' && config.ai.openaiKey) cached = new OpenAiProvider();
    else cached = null;
  } catch {
    cached = null;
  }
  return cached;
}

/** Separate instance for adjudication so it can run a different model. */
export function getAdjudicatorProvider(): LlmProvider | null {
  const base = getProvider();
  if (!base) return null;
  if (config.ai.adjudicatorModel === config.ai.model) return base;
  return config.ai.provider === 'anthropic'
    ? new AnthropicProvider(config.ai.adjudicatorModel)
    : new OpenAiProvider(config.ai.adjudicatorModel);
}

export function resetProviderCache(): void {
  cached = undefined;
}

export function providerLabel(): string {
  const p = getProvider();
  return p ? `${p.name}:${p.model}` : 'builtin:rule-based-reasoner';
}
