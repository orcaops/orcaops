#!/usr/bin/env node
import type { EvaluatorContext, EvaluatorResultEnvelope } from '@orcaops/evaluator-protocol';
import { pass, runIfDispatched, violation } from '@orcaops/evaluator-sdk';

interface Params {
  tokens: string[];
  exempt_scopes?: string[];
}

interface EvidenceSource {
  stepIndex: number;
  criterionIndex: number | null;
  stepText: string;
  text: string;
}

interface EvidenceMatch extends EvidenceSource {
  matched: string;
}

const CLAUSE_BOUNDARY = /[.;!?\n]/;
const POSITIVE_OVERRIDE_PREFIX = /\b(?:no|without)(?:\s+\S+){0,3}\s*$/u;
const POSITIVE_OVERRIDE_SUFFIX = /^\s+(?:fail|fails|failed|failing)\b/u;
const PREFIX_NEGATIONS = [
  /\b(?:no|without)(?:\s+\S+){0,3}\s*$/u,
  /\b(?:do not|don't|will not|won't|should not|shouldn't|must not|mustn't)(?:\s+\S+){0,4}\s*$/u,
  /\b(?:skip|omit|avoid|exclude)(?:\s+\S+){0,4}\s*$/u,
];
const SUFFIX_NEGATIONS = [
  /^\s+(?:(?:are|is|were|was|will be|should be|must be)\s+)?not\s+(?:needed|required|necessary|applicable|planned|run|executed)\b/u,
  /^\s+(?:are|is|were|was)\s+(?:unnecessary|inapplicable|optional)\b/u,
  /^\s+(?:are|is|were|was)\s+out\s+of\s+scope\b/u,
  /^\s+(?:are|is|were|was|will be|should be|must be)\s+(?:deferred|skipped|excluded)\b/u,
  /^\s+(?:aren't|isn't|weren't|wasn't)\s+(?:needed|required|necessary|applicable|planned|run|executed)\b/u,
  /^\s+(?:won't|will not|shouldn't|should not|mustn't|must not)\s+(?:be\s+)?(?:run|executed|added|updated)\b/u,
];

export function check(ctx: EvaluatorContext): EvaluatorResultEnvelope {
  const args = parseParams(ctx.params);
  const sources = evidenceSources(ctx);
  const available = inspectedCounts(sources);

  if (args.exempt_scopes && args.exempt_scopes.length > 0) {
    const declaredScopes = ctx.plan.touched_scope;
    const allScopesExempt =
      declaredScopes.length > 0 &&
      declaredScopes.every((scope) => args.exempt_scopes?.includes(scope) === true);
    if (allScopesExempt) {
      return pass(
        `PASS\n\nToken inspection was skipped because all declared scope tags are exempt ` +
          `from this check: ${declaredScopes.map((scope) => `\`${scope}\``).join(', ')}.` +
          `\n\n## inspected\n- 0 plan steps\n- 0 acceptance criteria` +
          `\n\n## available\n- ${available.steps} plan ` +
          `step${available.steps === 1 ? '' : 's'}\n- ${available.criteria} acceptance ` +
          `criteri${available.criteria === 1 ? 'on' : 'a'}`,
        {
          raw: {
            inspected: { steps: 0, criteria: 0 },
            available,
            inspectionSkipped: {
              reason: 'all-declared-scopes-exempt',
              declaredScopes,
            },
          },
        }
      );
    }
  }

  const matches: EvidenceMatch[] = [];
  const negatedMatches: EvidenceMatch[] = [];
  for (const source of sources) {
    let negatedMatch: EvidenceMatch | undefined;
    for (const token of args.tokens) {
      const occurrences = findTokenOccurrences(source.text, token);
      const positive = occurrences.find(
        (occurrence) => classifyOccurrence(source.text, occurrence) === 'positive'
      );
      if (positive !== undefined) {
        matches.push({ ...source, matched: token.toLowerCase() });
        negatedMatch = undefined;
        break;
      }
      if (occurrences.length > 0 && negatedMatch === undefined) {
        negatedMatch = { ...source, matched: token.toLowerCase() };
      }
    }
    if (negatedMatch !== undefined) negatedMatches.push(negatedMatch);
  }

  if (matches.length > 0) {
    const list = matches.map(formatMatch).join('\n');
    return pass(`PASS\n\n## findings\n${list}`, {
      raw: { matches: matches.map(rawMatch), inspected: inspectedCounts(sources) },
    });
  }

  const inspected = inspectedCounts(sources);
  const negated =
    negatedMatches.length === 0
      ? ''
      : `\n\n## ignored negated evidence\n${negatedMatches.map(formatMatch).join('\n')}`;
  return violation(
    `VIOLATION\n\nNo explicit, non-negated test intent was found in plan step text or ` +
      `acceptance criteria.\n\n## inspected\n- ${inspected.steps} plan ` +
      `step${inspected.steps === 1 ? '' : 's'}\n- ${inspected.criteria} acceptance ` +
      `criteri${inspected.criteria === 1 ? 'on' : 'a'}${negated}`,
    {
      raw: {
        tokens: args.tokens,
        planSteps: ctx.plan.plan_steps.map((step) => step.text),
        inspected,
        negatedMatches: negatedMatches.map(rawMatch),
      },
    }
  );
}

function evidenceSources(ctx: EvaluatorContext): EvidenceSource[] {
  return ctx.plan.plan_steps.flatMap((step, stepIndex) => [
    {
      stepIndex,
      criterionIndex: null,
      stepText: step.text,
      text: step.text,
    },
    ...step.acceptance_criteria.map((criterion, criterionIndex) => ({
      stepIndex,
      criterionIndex,
      stepText: step.text,
      text: criterion.text,
    })),
  ]);
}

function findTokenOccurrences(
  text: string,
  token: string
): Array<{ index: number; length: number }> {
  const pattern = new RegExp(
    `(?<![\\p{L}\\p{N}_])${escapeRegExp(token)}(?![\\p{L}\\p{N}_])`,
    'giu'
  );
  return Array.from(text.matchAll(pattern), (match) => ({
    index: match.index,
    length: match[0].length,
  }));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function classifyOccurrence(
  text: string,
  occurrence: { index: number; length: number }
): 'positive' | 'negative' {
  const clauseStart = lastBoundaryBefore(text, occurrence.index) + 1;
  const clauseEnd = nextBoundaryAfter(text, occurrence.index + occurrence.length);
  const before = text.slice(clauseStart, occurrence.index).toLowerCase();
  const after = text.slice(occurrence.index + occurrence.length, clauseEnd).toLowerCase();

  if (POSITIVE_OVERRIDE_PREFIX.test(before) && POSITIVE_OVERRIDE_SUFFIX.test(after)) {
    return 'positive';
  }

  const negative =
    PREFIX_NEGATIONS.some((pattern) => pattern.test(before)) ||
    SUFFIX_NEGATIONS.some((pattern) => pattern.test(after));
  return negative ? 'negative' : 'positive';
}

function lastBoundaryBefore(text: string, end: number): number {
  for (let index = end - 1; index >= 0; index -= 1) {
    if (CLAUSE_BOUNDARY.test(text[index])) return index;
  }
  return -1;
}

function nextBoundaryAfter(text: string, start: number): number {
  for (let index = start; index < text.length; index += 1) {
    if (CLAUSE_BOUNDARY.test(text[index])) return index;
  }
  return text.length;
}

function inspectedCounts(sources: EvidenceSource[]): { steps: number; criteria: number } {
  return {
    steps: sources.filter((source) => source.criterionIndex === null).length,
    criteria: sources.filter((source) => source.criterionIndex !== null).length,
  };
}

function formatMatch(match: EvidenceMatch): string {
  const location =
    match.criterionIndex === null
      ? `step ${match.stepIndex + 1}`
      : `step ${match.stepIndex + 1}, criterion ${match.criterionIndex + 1}`;
  return `- \`${match.matched}\` in ${location}: ${match.text}`;
}

function rawMatch(match: EvidenceMatch): Record<string, unknown> {
  return {
    step: match.stepText,
    matched: match.matched,
    source: match.criterionIndex === null ? 'step' : 'criterion',
    stepIndex: match.stepIndex + 1,
    ...(match.criterionIndex !== null ? { criterionIndex: match.criterionIndex + 1 } : {}),
    text: match.text,
  };
}

function parseParams(raw: Record<string, unknown>): Params {
  const tokens = raw.tokens;
  if (!Array.isArray(tokens) || tokens.some((t) => typeof t !== 'string')) {
    throw new Error('plan-mentions: `tokens` must be a string array');
  }
  const exempt = raw.exempt_scopes;
  if (exempt !== undefined) {
    if (!Array.isArray(exempt) || exempt.some((s) => typeof s !== 'string')) {
      throw new Error('plan-mentions: `exempt_scopes` must be a string array if set');
    }
  }
  return {
    tokens: tokens as string[],
    exempt_scopes: exempt as string[] | undefined,
  };
}

runIfDispatched(check);
