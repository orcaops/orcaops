import { EvaluatorRefRegex } from '@orcaops/evaluator-protocol';

import { ErrorCodes, OrcaopsError } from '../../io/errors.js';
import { CliExit } from '../../io/exit.js';
import { emitError, emitOk, writeErrorLine, writeTerminalSafeStdout } from '../../io/output.js';
import { buildContext } from '../../lib/context.js';
import { discoverEvaluatorsForCli, evaluatorNotFound } from '../../lib/evaluator-discovery.js';
import {
  EVALUATOR_CONFIG_FILE,
  readEvaluatorsConfig,
  writeEvaluatorsConfig,
} from '../../lib/evaluators-config.js';

export interface ToggleEvaluatorOptions {
  ref: string;
  json?: boolean;
}

interface ToggleResult {
  ok: true;
  ref: string;
  enabled: boolean;
  config_path: string;
  previous_enabled: boolean | null;
}

export async function evalEnableAction(opts: ToggleEvaluatorOptions): Promise<void> {
  await runToggle(opts, true);
}

export async function evalDisableAction(opts: ToggleEvaluatorOptions): Promise<void> {
  await runToggle(opts, false);
}

async function runToggle(opts: ToggleEvaluatorOptions, enabled: boolean): Promise<void> {
  try {
    const result = await applyToggle(opts, enabled);
    if (opts.json) {
      emitOk(result);
      return;
    }
    const verb = result.enabled ? 'Enabled' : 'Disabled';
    const wasNoop = result.previous_enabled !== null && result.previous_enabled === result.enabled;
    writeTerminalSafeStdout(
      wasNoop
        ? `${verb} "${result.ref}" (no-op — already ${result.enabled}).\n`
        : `${verb} "${result.ref}" in ${result.config_path}.\n`
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

async function applyToggle(opts: ToggleEvaluatorOptions, enabled: boolean): Promise<ToggleResult> {
  const ctx = await buildContext();
  try {
    const config = await readEvaluatorsConfig(ctx.repoRoot);
    if (config === null) {
      throw new OrcaopsError(
        ErrorCodes.UNINITIALIZED,
        `${EVALUATOR_CONFIG_FILE} not found; run \`orcaops eval add-pack <source>\` first.`
      );
    }
    if (!EvaluatorRefRegex.test(opts.ref)) {
      throw new OrcaopsError(
        ErrorCodes.INVALID_INPUT,
        `Evaluator ref must be "<pack-id>/<evaluator-id>"; got "${opts.ref}".`
      );
    }
    const [packId] = opts.ref.split('/', 1);
    if (!config.packages.some((p) => p.id === packId)) {
      throw new OrcaopsError(
        ErrorCodes.INVALID_INPUT,
        `Pack "${packId}" is not registered. Add it first with \`orcaops eval add-pack\`.`
      );
    }
    const { evaluators, errors } = await discoverEvaluatorsForCli(ctx.repoRoot);
    if (!evaluators.some((evaluator) => evaluator.ref === opts.ref)) {
      throw evaluatorNotFound(opts.ref, errors);
    }
    const prior = config.evaluators[opts.ref] ?? null;
    const nextConfig = {
      ...config,
      evaluators: {
        ...config.evaluators,
        [opts.ref]: { ...(prior ?? {}), enabled },
      },
    };
    await writeEvaluatorsConfig(ctx.repoRoot, nextConfig);

    return {
      ok: true,
      ref: opts.ref,
      enabled,
      config_path: EVALUATOR_CONFIG_FILE,
      previous_enabled: prior?.enabled ?? null,
    };
  } finally {
    ctx.store.close();
  }
}
