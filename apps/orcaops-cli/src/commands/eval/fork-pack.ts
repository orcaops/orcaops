import { existsSync } from 'node:fs';
import { cp, mkdir } from 'node:fs/promises';
import path from 'node:path';

import { resolvePackSource } from '@orcaops/evaluator-runner';
import { assertResolvedWithin } from '@orcaops/storage';

import { ErrorCodes, OrcaopsError } from '../../io/errors.js';
import { CliExit } from '../../io/exit.js';
import { emitError, emitOk, writeErrorLine, writeTerminalSafeStdout } from '../../io/output.js';
import { buildContext } from '../../lib/context.js';
import {
  CLI_ROOT,
  EVALUATOR_CONFIG_FILE,
  readEvaluatorsConfig,
  validateEvaluatorsConfig,
  writeEvaluatorState,
} from '../../lib/evaluators-config.js';

export interface ForkPackOptions {
  packId: string;
  to: string;
  json?: boolean;
}

interface ForkPackResult {
  ok: true;
  pack_id: string;
  forked_to: string;
  grant_revoked: boolean;
  warning: string;
}

export async function evalForkPackAction(opts: ForkPackOptions): Promise<void> {
  try {
    const result = await runForkPack(opts);
    if (opts.json) {
      emitOk(result);
      return;
    }
    writeTerminalSafeStdout(
      `Forked pack "${result.pack_id}" into ${result.forked_to}.\n` +
        `Switched ${EVALUATOR_CONFIG_FILE} entry to \`kind: path\`.\n\n` +
        `${result.warning}\n`
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

async function runForkPack(opts: ForkPackOptions): Promise<ForkPackResult> {
  const ctx = await buildContext();
  try {
    const config = await readEvaluatorsConfig(ctx.repoRoot);
    if (config === null) {
      throw new OrcaopsError(
        ErrorCodes.UNINITIALIZED,
        `${EVALUATOR_CONFIG_FILE} not found; nothing to fork.`
      );
    }
    const entry = config.packages.find((p) => p.id === opts.packId);
    if (!entry) {
      throw new OrcaopsError(
        ErrorCodes.INVALID_INPUT,
        `Pack "${opts.packId}" is not registered. Known packs: [${config.packages.map((p) => p.id).join(', ')}]`
      );
    }
    if (entry.source.kind === 'path') {
      throw new OrcaopsError(
        ErrorCodes.INVALID_INPUT,
        `Pack "${opts.packId}" is already path-sourced; nothing to fork.`
      );
    }

    let resolved;
    try {
      resolved = await resolvePackSource(entry.source, {
        repoRoot: ctx.repoRoot,
        cliRoot: CLI_ROOT,
      });
    } catch (err) {
      throw new OrcaopsError(
        ErrorCodes.PACK_RESOLUTION,
        err instanceof Error ? err.message : String(err)
      );
    }

    const externalTarget = path.isAbsolute(opts.to);
    const resolveTarget = (): string =>
      externalTarget
        ? path.resolve(opts.to)
        : assertResolvedWithin(
            path.join(ctx.repoRoot, opts.to),
            ctx.repoRoot,
            'evaluator fork target',
            { rejectSymlinks: true }
          );
    let target = resolveTarget();
    if (existsSync(target)) {
      throw new OrcaopsError(
        ErrorCodes.INVALID_INPUT,
        `Fork target ${opts.to} already exists. Remove it or pick a different --to path.`
      );
    }
    await mkdir(path.dirname(target), { recursive: true });
    target = resolveTarget();
    await cp(resolved.pack_root, target, { recursive: true });

    const relTarget = externalTarget ? target : './' + path.relative(ctx.repoRoot, target);
    const nextConfig = {
      ...config,
      runtime: { ...config.runtime },
      packages: config.packages.map((candidate) =>
        candidate.id === opts.packId
          ? { ...candidate, source: { kind: 'path' as const, path: relTarget } }
          : { ...candidate, source: { ...candidate.source } }
      ),
      evaluators: { ...config.evaluators },
    };
    const validatedConfig = validateEvaluatorsConfig(nextConfig);
    const grantRevoked = await writeEvaluatorState(ctx.repoRoot, validatedConfig, {
      kind: 'revoke',
      packageId: opts.packId,
    });

    return {
      ok: true,
      pack_id: opts.packId,
      forked_to: relTarget,
      grant_revoked: grantRevoked,
      warning:
        `${grantRevoked ? 'The prior source trust grant was revoked. ' : ''}` +
        'update-pack is now a manual sync — re-running it for a path-sourced pack only ' +
        're-validates the directory. You are responsible for content updates and trust for the fork.',
    };
  } finally {
    ctx.store.close();
  }
}
