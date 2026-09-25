import {
  type EvaluatorFinding,
  FINDINGS_BLOCK_INFO_STRING,
  FINDINGS_BLOCK_SCHEMA,
  VERDICT_SENTINEL_INFO_STRING,
} from '@orcaops/evaluator-protocol';

/**
 * Build the markdown response a model would return, for the LLM contract
 * tests. Assembled rather than written out as one literal so that the two
 * fences are guaranteed to be at the left margin, which is the only place the
 * parsers read them — a response indented by a stray editor would otherwise
 * make a test claim the prompt is broken.
 *
 * The `_test-` prefix keeps it out of the shipped pack: `tsconfig.packs.json`
 * excludes that stem from the runtime build.
 */
export function respond(opts: {
  prose: string;
  /** Omit for a response that offers no findings at all. */
  findings?: readonly EvaluatorFinding[];
  verdict: 'PASS' | 'VIOLATION' | 'INFO';
}): string {
  const block =
    opts.findings === undefined
      ? []
      : [
          '```' + FINDINGS_BLOCK_INFO_STRING,
          JSON.stringify({ schema: FINDINGS_BLOCK_SCHEMA, findings: opts.findings }),
          '```',
          '',
        ];
  return [
    opts.prose,
    '',
    ...block,
    '```' + VERDICT_SENTINEL_INFO_STRING,
    opts.verdict,
    '```',
    '',
  ].join('\n');
}
