#!/usr/bin/env node
/**
 * Demo command-engine entry-point. Reads EvaluatorContext (just to
 * prove the contract works) and emits a fixed PASS envelope. Pack
 * authors writing their first command-engine evaluator can copy
 * this as the minimum viable shape.
 */
import type { EvaluatorContext, EvaluatorResultEnvelope } from '@orcaops/evaluator-protocol';
import { pass, runIfDispatched } from '@orcaops/evaluator-sdk';

export function check(ctx: EvaluatorContext): EvaluatorResultEnvelope {
  return pass(`PASS\n\nHello from packs/demo at phase=${ctx.phase}.`);
}

runIfDispatched(check);
