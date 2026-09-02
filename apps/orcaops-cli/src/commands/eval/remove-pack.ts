import { ErrorCodes, OrcaopsError } from '../../io/errors.js';
import { CliExit } from '../../io/exit.js';
import { emitError, emitOk, writeErrorLine, writeTerminalSafeStdout } from '../../io/output.js';
import { buildContext } from '../../lib/context.js';
import {
  EVALUATOR_CONFIG_FILE,
  readEvaluatorsConfig,
  validateEvaluatorsConfig,
  writeEvaluatorState,
} from '../../lib/evaluators-config.js';

export interface RemovePackOptions {
  packId: string;
  json?: boolean;
}

interface RemovePackResult {
  ok: true;
  pack_id: string;
  evaluators_removed: string[];
  grant_revoked: boolean;
  config_path: string;
}

export async function evalRemovePackAction(opts: RemovePackOptions): Promise<void> {
  try {
    const result = await runRemovePack(opts);
    if (opts.json) {
      emitOk(result);
      return;
    }
    writeTerminalSafeStdout(
      `Removed pack "${result.pack_id}" and ${result.evaluators_removed.length} evaluator override(s) from ${result.config_path}.` +
        `${result.grant_revoked ? ' Revoked its user-local trust grant.' : ''}\n`
    );
  } catch (err) {
    if (opts.json) emitError(err);
    if (err instanceof OrcaopsError) {
      writeErrorLine(err);
      throw new CliExit(1);
    }
    throw err;
  }
}

async function runRemovePack(opts: RemovePackOptions): Promise<RemovePackResult> {
  const ctx = await buildContext();
  try {
    const config = await readEvaluatorsConfig(ctx.repoRoot);
    if (config === null) {
      throw new OrcaopsError(
        ErrorCodes.UNINITIALIZED,
        `${EVALUATOR_CONFIG_FILE} not found; nothing to remove. Run \`orcaops eval add-pack <source>\` first.`
      );
    }
    const idx = config.packages.findIndex((p) => p.id === opts.packId);
    if (idx === -1) {
      throw new OrcaopsError(
        ErrorCodes.INVALID_INPUT,
        `Pack "${opts.packId}" is not registered. Known packs: [${config.packages.map((p) => p.id).join(', ')}]`
      );
    }
    const nextConfig = {
      ...config,
      runtime: { ...config.runtime },
      packages: config.packages
        .filter((_, packageIndex) => packageIndex !== idx)
        .map((pack) => ({ ...pack, source: { ...pack.source } })),
      evaluators: { ...config.evaluators },
    };

    const removedRefs: string[] = [];
    const prefix = `${opts.packId}/`;
    for (const ref of Object.keys(nextConfig.evaluators)) {
      if (ref.startsWith(prefix)) {
        delete nextConfig.evaluators[ref];
        removedRefs.push(ref);
      }
    }

    const validatedConfig = validateEvaluatorsConfig(nextConfig);
    const grantRevoked = await writeEvaluatorState(ctx.repoRoot, validatedConfig, {
      kind: 'revoke',
      packageId: opts.packId,
    });

    return {
      ok: true,
      pack_id: opts.packId,
      evaluators_removed: removedRefs.sort(),
      grant_revoked: grantRevoked,
      config_path: EVALUATOR_CONFIG_FILE,
    };
  } finally {
    ctx.store.close();
  }
}
