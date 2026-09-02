#!/usr/bin/env node
/**
 * Demo blocking evaluator. Always emits a VIOLATION envelope so
 * pack authors can see the gate-rejection path end-to-end.
 *
 * To stop it from blocking checkpoint-open, either:
 *   - retry the open with `policy_exceptions[]` naming `demo/always-block`
 *   - set `demo/always-block.enabled: false` in `.orcaops/evaluators.yaml`
 */
import type { EvaluatorContext, EvaluatorResultEnvelope } from '@orcaops/evaluator-protocol';
import { runIfDispatched, violation } from '@orcaops/evaluator-sdk';

export function check(_ctx: EvaluatorContext): EvaluatorResultEnvelope {
  return violation(
    'VIOLATION\n\nThis is the demo blocking evaluator. It always fires.\n\n' +
      'To stop it from blocking checkpoint-open, either:\n' +
      '  - retry the open with `policy_exceptions: [{ evaluator: "demo/always-block", reason: "<...>" }]`\n' +
      '  - or set `demo/always-block.enabled: false` in `.orcaops/evaluators.yaml`'
  );
}

runIfDispatched(check);
