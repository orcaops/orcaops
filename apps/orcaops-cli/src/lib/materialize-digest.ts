import { writeDigest } from '@orcaops/core';

import type { CliContext } from './context.js';
import { discoverEvaluatorsForCli } from './evaluator-discovery.js';

export async function materializeDigest(ctx: CliContext, artifactId: string) {
  const { evaluators } = await discoverEvaluatorsForCli(ctx.repoRoot);
  const descriptions = new Map<string, string>();
  for (const evaluator of evaluators) {
    if (evaluator.description !== undefined) {
      descriptions.set(evaluator.ref, evaluator.description);
    }
  }
  return writeDigest({
    store: ctx.store,
    artifactId,
    evaluatorDescriptions: descriptions,
    redactSecrets: ctx.config.digest.redact_secrets,
  });
}
