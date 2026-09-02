import { readFile } from 'node:fs/promises';

import { CliExit } from '../../io/exit.js';
import { emitError, emitOk, writeErrorLine, writeTerminalSafeStdout } from '../../io/output.js';
import { buildContext } from '../../lib/context.js';
import { discoverEvaluatorsForCli, evaluatorNotFound } from '../../lib/evaluator-discovery.js';

export interface EvalShowOptions {
  json?: boolean;
}

/**
 * `orcaops eval show <ref>` — render a single evaluator's resolved
 * spec. Takes a `<pack>/<id>` ref (the new addressing scheme); falls
 * back to a friendly error when the ref doesn't resolve.
 *
 * Human-format dumps the spec file's raw YAML; JSON-format emits the
 * full `ResolvedEvaluator` so consumers can introspect every
 * resolution-time decision (params merge result, severity override,
 * resolution.acknowledge.enabled, etc.) without re-implementing
 * resolution themselves.
 */
export async function evalShowAction(ref: string, opts: EvalShowOptions = {}): Promise<void> {
  try {
    const ctx = await buildContext({ mintArchiveIdentity: false });
    try {
      const { evaluators, errors } = await discoverEvaluatorsForCli(ctx.repoRoot);
      const evaluator = evaluators.find((e) => e.ref === ref);
      if (!evaluator) throw evaluatorNotFound(ref, errors);
      if (opts.json) {
        emitOk({ evaluator });
        return;
      }
      const raw = await readFile(evaluator.spec_path, 'utf8');
      writeTerminalSafeStdout(raw);
      if (!raw.endsWith('\n')) writeTerminalSafeStdout('\n');
    } finally {
      ctx.store.close();
    }
  } catch (err) {
    if (opts.json) emitError(err);
    writeErrorLine(err);
    throw new CliExit(1);
  }
}
