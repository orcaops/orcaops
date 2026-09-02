import {
  buildContextBlock,
  composeEvaluatorPrompt,
  type ContextSection,
  type EvaluatorContext,
  type EvaluatorVerdict,
  parseMarkdownVerdict,
} from '@orcaops/evaluator-protocol';

export interface RunLlmFixtureOptions {
  /** The fixture's `EvaluatorContext` — build one with `makeContext()`. */
  context: EvaluatorContext;
  /** The evaluator's prompt body: the contents of its `engine.prompt_file`. */
  promptBody: string;
  /** The spec's `engine.additional_context_sections`. */
  additionalContextSections: readonly ContextSection[];
  /**
   * The response to parse, standing in for the provider's. Supply the exact
   * text you expect a model to produce — including any sentinel it echoes
   * from your prompt.
   */
  response: string;
}

export interface RunLlmFixtureResult {
  /** The full prompt the provider would have received. */
  prompt: string;
  /** Just the auto-prepended `## Context` block, for asserting on egress. */
  contextBlock: string;
  /**
   * The verdict the runner would record. `null` when the response carries
   * none — the runner turns that into `NO_VERDICT_LINE`, so this harness
   * reports it rather than throwing.
   */
  verdict: EvaluatorVerdict | null;
}

/**
 * Exercise an LLM evaluator's contract without calling a provider: assemble
 * the prompt exactly as the runner does, then parse a response you supply.
 *
 * The two halves are what a pack author can actually get wrong and what no
 * amount of model quality will fix — whether the prompt contains the data it
 * asks the model to reason over, and whether the response shape it documents
 * parses to the verdict it means. Both are deterministic, so both belong in
 * an ordinary unit test.
 *
 * Deliberately provider-free: it constructs no client, resolves no consent,
 * and dispatches nothing, so provider identity has no place in its signature.
 * What a real provider does with the prompt is a different question, answered
 * by the CLI's integration tests.
 */
export function runLlmFixture(opts: RunLlmFixtureOptions): RunLlmFixtureResult {
  return {
    prompt: composeEvaluatorPrompt({
      context: opts.context,
      additionalSections: opts.additionalContextSections,
      promptBody: opts.promptBody,
    }),
    // Rendered again rather than sliced back out of `prompt`: a pinned source
    // plan can itself contain a `## Task` heading, and splitting on that
    // would silently truncate the block a test is asserting against.
    contextBlock: buildContextBlock(opts.context, opts.additionalContextSections),
    verdict: parseMarkdownVerdict(opts.response),
  };
}
