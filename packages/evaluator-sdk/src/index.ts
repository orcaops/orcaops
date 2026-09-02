/**
 * `@orcaops/evaluator-sdk` — contract-only helpers for evaluator pack
 * runtimes. Pack authors depend on this AND `@orcaops/evaluator-protocol`;
 * nothing else from the orcaops workspace should be needed to write a
 * conforming evaluator.
 *
 * Scope: only helpers that are specific to the Orcaops evaluator
 * contract and hard to get right consistently. NOT a grab-bag of
 * domain utilities (no secret detection, no glob matching, no
 * markdown parsing, no TypeScript compiler wrappers) — those belong
 * inside individual packs.
 */

export const PACKAGE_NAME = '@orcaops/evaluator-sdk';

// Re-export the type surface evaluators consume so packs only need
// one import line for both the SDK and the protocol types.
export type {
  ContextSection,
  EvaluatorContext,
  EvaluatorPhase,
  EvaluatorRef,
  EvaluatorResultEnvelope,
  EvaluatorRunStatus,
  EvaluatorSeverity,
  EvaluatorVerdict,
  PlanContext,
  CheckpointContext,
  SummaryContext,
  RepoContext,
} from '@orcaops/evaluator-protocol';

export { ORCAOPS_CONTEXT_PATH_ENV, readEvaluatorContext } from './context.js';
export type { ReadEvaluatorContextOptions } from './context.js';
export { info, pass, violation, writeResult } from './result.js';
export type { EnvelopeExtras } from './result.js';
export { safeExecute } from './errors.js';
export { runFixture, RunFixtureError } from './fixture.js';
export type { RunFixtureOptions, RunFixtureResult } from './fixture.js';
export { makeContext, makePlanStep } from './make-context.js';
export { runLlmFixture } from './llm-fixture.js';
export type { RunLlmFixtureOptions, RunLlmFixtureResult } from './llm-fixture.js';
export { runIfDispatched } from './runtime.js';
