import type { AdjudicationInput } from './adjudicator.ts';
import type { Decision } from '../types.ts';

/**
 * The deterministic built-in reasoner, used when no LLM key is configured.
 *
 * It is not pretending to be a language model. It is a transparent lexical
 * relevance check: does the thing being bought share meaningful vocabulary
 * with the purpose the mandate was granted for, and does the agent's stated
 * justification actually reference the purchase? That catches the blunt
 * failure mode (an agent funded for cloud infrastructure buying furniture)
 * while being honest about what it cannot catch.
 *
 * Because it is deterministic it is also what the unit tests assert against,
 * which keeps the policy pipeline testable without network calls.
 */

const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'for', 'to', 'of', 'in', 'on', 'at', 'by', 'with', 'from', 'up', 'as', 'is', 'are',
  'was', 'be', 'been', 'this', 'that', 'these', 'those', 'it', 'its', 'our', 'we', 'i', 'you', 'your', 'they', 'them',
  'buy', 'buying', 'purchase', 'purchasing', 'need', 'needed', 'needs', 'order', 'spend', 'spending', 'pay', 'paying',
  'use', 'used', 'using', 'get', 'getting', 'any', 'all', 'some', 'per', 'via', 'plus', 'new', 'one', 'two', 'month',
  'monthly', 'year', 'annual', 'team', 'teams', 'work', 'business',
]);

function tokenise(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9+#.]+/)) {
    const t = raw.replace(/^[.+]+|[.+]+$/g, '');
    if (t.length < 3 || STOPWORDS.has(t)) continue;
    // Crude singularisation so "licenses" matches "license".
    out.add(t.endsWith('s') && t.length > 4 ? t.slice(0, -1) : t);
  }
  return out;
}

function overlap(a: Set<string>, b: Set<string>): { shared: string[]; ratio: number } {
  const shared = [...a].filter((t) => b.has(t));
  const denom = Math.min(a.size, b.size) || 1;
  return { shared, ratio: shared.length / denom };
}

export interface HeuristicJudgement {
  decision: Decision;
  confidence: number;
  rationale: string;
  riskFlags: string[];
}

export function adjudicateHeuristically(input: AdjudicationInput): HeuristicJudgement {
  const purposeTokens = tokenise(input.mandate.purpose);
  const purchaseTokens = tokenise(`${input.request.description} ${input.request.category} ${input.merchantName}`);
  const justificationTokens = tokenise(input.request.justification);

  const purposeMatch = overlap(purposeTokens, purchaseTokens);
  const justificationMatch = overlap(justificationTokens, purchaseTokens);

  const riskFlags: string[] = [];

  // A category the mandate's purpose never alludes to is the strongest signal.
  const categoryMentioned = purposeTokens.has(
    input.request.category.toLowerCase().endsWith('s') && input.request.category.length > 4
      ? input.request.category.toLowerCase().slice(0, -1)
      : input.request.category.toLowerCase(),
  );

  if (purposeMatch.shared.length === 0 && !categoryMentioned) riskFlags.push('NO_VOCABULARY_OVERLAP_WITH_MANDATE_PURPOSE');
  if (input.request.justification.trim().length < 20) riskFlags.push('THIN_JUSTIFICATION');
  if (justificationMatch.shared.length === 0 && input.request.justification.trim().length >= 20) {
    riskFlags.push('JUSTIFICATION_DOES_NOT_REFERENCE_PURCHASE');
  }
  if (input.request.amountMinor >= input.mandate.autoApproveLimitMinor) riskFlags.push('AT_OR_ABOVE_AUTONOMOUS_LIMIT');
  for (const r of input.policyFlags) riskFlags.push(`POLICY_${r}`);

  const aligned = purposeMatch.shared.length > 0 || categoryMentioned;
  const strongly = purposeMatch.ratio >= 0.25 || categoryMentioned;

  if (!aligned) {
    return {
      decision: 'DENY',
      confidence: 0.72,
      rationale:
        `The purchase ("${input.request.description}", category "${input.request.category}") shares no meaningful vocabulary with the mandate purpose ` +
        `("${input.mandate.purpose}"). Lexical relevance analysis found no overlapping terms, so this spend appears to fall outside what the mandate authorises.`,
      riskFlags,
    };
  }

  if (!strongly || riskFlags.some((f) => f === 'THIN_JUSTIFICATION' || f === 'JUSTIFICATION_DOES_NOT_REFERENCE_PURCHASE')) {
    return {
      decision: 'ESCALATE',
      confidence: 0.55,
      rationale:
        `The purchase is plausibly related to the mandate purpose (shared terms: ${purposeMatch.shared.join(', ') || 'category match only'}), ` +
        `but the link is weak or the agent's justification does not clearly explain it. Referring to a human rather than settling autonomously.`,
      riskFlags,
    };
  }

  return {
    decision: 'APPROVE',
    confidence: Math.min(0.9, 0.6 + purposeMatch.ratio),
    rationale:
      `The purchase aligns with the mandate purpose. Shared terms: ${purposeMatch.shared.join(', ') || input.request.category}. ` +
      `The agent's justification references the purchase and no policy signals were raised.`,
    riskFlags,
  };
}
