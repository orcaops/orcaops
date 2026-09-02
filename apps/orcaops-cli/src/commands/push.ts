import {
  pushArtifact,
  type PushArtifactResult,
  resolveCloudTarget,
  resolveCredentialStore,
} from '@orcaops/core';

import { toCloudErrorEnvelope } from '../io/cloud-error-envelope.js';
import { ErrorCodes, OrcaopsError } from '../io/errors.js';
import { emitError, emitOk, writeTerminalSafeStdout } from '../io/output.js';
import { CLI_VERSION } from '../lib/cli-version.js';
import { buildContext } from '../lib/context.js';

export interface PushOptions {
  force?: boolean;
  baseUrl?: string;
  json?: boolean;
}

/**
 * Push an artifact's plan/checkpoints/summary/evaluators to the cloud.
 *
 * Pre-conditions:
 *   - `orcaops login` has been run (`~/.orcaops/credentials.json` exists)
 *   - the artifact exists locally (was captured via `orcaops capture plan ...`)
 *   - `git remote get-url origin` returns a URL
 *
 * Idempotent: re-running on an unchanged artifact tree skips the network
 * round-trip via the cloud_sync_hash. Pass `--force` to always send.
 */
export async function pushAction(artifactId: string, opts: PushOptions = {}): Promise<void> {
  try {
    if (!artifactId || artifactId.length === 0) {
      throw new OrcaopsError(ErrorCodes.NO_INPUT, 'artifact_id is required.');
    }

    const credentialStore = resolveCredentialStore();
    const baseUrl = resolveCloudTarget(opts.baseUrl);

    const ctx = await buildContext();
    let result: PushArtifactResult;
    try {
      result = await pushArtifact({
        store: ctx.store,
        repo: ctx.repo,
        artifactId,
        force: opts.force,
        baseUrl,
        credentialStore,
        cliVersion: CLI_VERSION,
        repoRoot: ctx.repoRoot,
      });
    } finally {
      ctx.store.close();
    }

    if (opts.json) {
      emitOk(result);
      return;
    }

    if (result.skipped) {
      writeTerminalSafeStdout(`Up to date — nothing to push (artifact ${result.externalId}).\n`);
      return;
    }

    const a = result.attached!;
    const pinLine =
      result.source_plan_pinned === 'A' || result.source_plan_pinned === 'B'
        ? `  source plan: ✓ pinned (Branch ${result.source_plan_pinned})\n`
        : '';
    writeTerminalSafeStdout(
      `Pushed ${artifactId} → artifact ${result.externalId}\n` +
        `  plan:        ${a.plan ? '✓' : '·'}\n` +
        `  checkpoints: ${a.checkpoints}\n` +
        `  summary:     ${a.summary ? '✓' : '·'}\n` +
        `  evaluators:  ${a.evaluators}\n` +
        pinLine
    );
  } catch (err) {
    emitError(toCloudErrorEnvelope(err));
  }
}
