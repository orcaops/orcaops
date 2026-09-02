import {
  computePackSourceFingerprint,
  isTrustCapability,
  type PackValidationResult,
  resolvePackSource,
  validatePack,
} from '@orcaops/evaluator-runner';
import { resolveDefaultProvider } from '@orcaops/llm';

import { regrantCommandFor, seedEnableDecision } from './add-pack.js';
import { ErrorCodes, OrcaopsError } from '../../io/errors.js';
import { CliExit } from '../../io/exit.js';
import {
  emitError,
  emitOk,
  writeErrorLine,
  writeTerminalSafeStderr,
  writeTerminalSafeStdout,
} from '../../io/output.js';
import { buildContext } from '../../lib/context.js';
import { readGrants } from '../../lib/evaluator-grants.js';
import {
  CLI_ROOT,
  EVALUATOR_CONFIG_FILE,
  readEvaluatorsConfig,
  validateEvaluatorsConfig,
  writeEvaluatorsConfig,
  writeEvaluatorState,
} from '../../lib/evaluators-config.js';
import { getInvocationEnv } from '../../lib/invocation-context.js';

export interface UpdatePackOptions {
  packId: string;
  json?: boolean;
}

interface UpdatePackResult {
  ok: true;
  pack_id: string;
  source_kind: 'bundled' | 'path' | 'package';
  pack_root: string;
  warnings: Array<{ code: string; message: string; refs: string[] }>;
  /**
   * Human-facing note about what update-pack actually did. Updates
   * are mostly informational — the source descriptor stays, the
   * resolver re-derives the pack_root, and any user evaluators[]
   * overrides are preserved verbatim.
   */
  note: string;
  /** True when the pack's user-local grant was revoked by this call. */
  trust_invalidated: boolean;
  /** Refs the pack gained since registration, seeded enabled by this call. */
  evaluators_seeded: string[];
  /** Refs the pack gained since registration, seeded disabled (llm-engine under the deterministic default, or `default_enabled: false`). */
  evaluators_seeded_disabled: string[];
  /** Refs that no longer exist in the refreshed pack and were pruned. */
  evaluators_removed: string[];
}

export async function evalUpdatePackAction(opts: UpdatePackOptions): Promise<void> {
  try {
    const result = await runUpdatePack(opts);
    if (opts.json) {
      emitOk(result);
      return;
    }
    writeTerminalSafeStdout(formatHumanResult(result));
  } catch (err) {
    if (opts.json) emitError(err);
    if (err instanceof OrcaopsError) {
      writeErrorLine(err);
      throw new CliExit(1);
    }
    throw err;
  }
}

async function runUpdatePack(opts: UpdatePackOptions): Promise<UpdatePackResult> {
  const ctx = await buildContext();
  try {
    const config = await readEvaluatorsConfig(ctx.repoRoot);
    if (config === null) {
      throw new OrcaopsError(
        ErrorCodes.UNINITIALIZED,
        `${EVALUATOR_CONFIG_FILE} not found; nothing to update.`
      );
    }
    const entry = config.packages.find((p) => p.id === opts.packId);
    if (!entry) {
      throw new OrcaopsError(
        ErrorCodes.INVALID_INPUT,
        `Pack "${opts.packId}" is not registered. Known packs: [${config.packages.map((p) => p.id).join(', ')}]`
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

    // Classify with the effective provider the dispatch gate will see, so
    // the re-derived trust posture matches what dispatch will enforce.
    const validation = await validatePack(resolved, {
      defaultLlmProvider: await resolveDefaultProvider(ctx.config.llm, getInvocationEnv()),
    });
    if (!validation.ok) {
      throw new OrcaopsError(
        ErrorCodes.PACK_VALIDATION,
        `Pack failed validation:\n${formatErrors(validation)}`
      );
    }

    const nextConfig = {
      ...config,
      runtime: { ...config.runtime },
      packages: config.packages.map((pack) => ({ ...pack, source: { ...pack.source } })),
      evaluators: { ...config.evaluators },
    };
    const discoveredRefs = new Set(
      validation.specs.map((loaded) => `${opts.packId}/${loaded.spec.id}`)
    );
    const removedRefs: string[] = [];
    const prefix = `${opts.packId}/`;
    for (const ref of Object.keys(nextConfig.evaluators)) {
      if (ref.startsWith(prefix) && !discoveredRefs.has(ref)) {
        delete nextConfig.evaluators[ref];
        removedRefs.push(ref);
      }
    }

    let trustInvalidated = false;
    let trustInvalidationReason: 'capabilities_removed' | 'source_changed' | null = null;
    const hasTrustWarning = validation.warnings.some((warning) => isTrustCapability(warning.code));
    const { grants } = readGrants({
      repoRoot: ctx.repoRoot,
      warn: (message) => writeTerminalSafeStderr(`${message}\n`),
    });
    const grant = grants.find((g) => g.package_id === opts.packId);
    if (grant !== undefined) {
      if (!hasTrustWarning) {
        trustInvalidated = true;
        trustInvalidationReason = 'capabilities_removed';
      } else if (grant.kind === 'fingerprint') {
        const { fingerprint } = await computePackSourceFingerprint(resolved);
        if (grant.source_fingerprint !== fingerprint) {
          trustInvalidated = true;
          trustInvalidationReason = 'source_changed';
        }
      }
    }

    const overrides = nextConfig.evaluators;
    const seededEnabled: string[] = [];
    const seededDisabled: string[] = [];
    for (const loaded of validation.specs) {
      const ref = `${opts.packId}/${loaded.spec.id}`;
      if (overrides[ref] !== undefined) continue;
      const enable = seedEnableDecision(loaded.spec, 'deterministic');
      overrides[ref] = { enabled: enable };
      (enable ? seededEnabled : seededDisabled).push(ref);
    }
    const validatedConfig = validateEvaluatorsConfig(nextConfig);
    const configDirty = removedRefs.length + seededEnabled.length + seededDisabled.length > 0;

    if (trustInvalidated) {
      await writeEvaluatorState(ctx.repoRoot, validatedConfig, {
        kind: 'revoke',
        packageId: opts.packId,
      });
      const notice =
        trustInvalidationReason === 'capabilities_removed'
          ? `Notice: Pack "${opts.packId}" no longer requires evaluator trust ` +
            `(no command or LLM capability warnings); the user-local grant has been revoked.\n`
          : `Notice: Pack "${opts.packId}" has covered pack files that changed since trust ` +
            `was granted (source_fingerprint mismatch); the user-local grant has been revoked. ` +
            `Run \`orcaops eval trust ${opts.packId}\` to inspect and re-grant.\n`;
      writeTerminalSafeStderr(notice);
    } else if (configDirty) {
      await writeEvaluatorsConfig(ctx.repoRoot, validatedConfig);
    }

    return {
      ok: true,
      pack_id: opts.packId,
      source_kind: entry.source.kind,
      pack_root: resolved.pack_root,
      warnings: validation.warnings.map((w) => ({
        code: w.code,
        message: w.message,
        refs: w.refs,
      })),
      note: trustInvalidated
        ? trustInvalidationReason === 'capabilities_removed'
          ? 'Trust grant cleared (no command or LLM evaluators remain).'
          : `Trust grant cleared (pack source has changed since the grant). Re-run \`${regrantCommandFor(entry.source, opts.packId)}\` to inspect and re-grant.`
        : noteForSourceKind(entry.source.kind),
      trust_invalidated: trustInvalidated,
      evaluators_seeded: seededEnabled.sort(),
      evaluators_seeded_disabled: seededDisabled.sort(),
      evaluators_removed: removedRefs.sort(),
    };
  } finally {
    ctx.store.close();
  }
}

function noteForSourceKind(kind: 'bundled' | 'path' | 'package'): string {
  switch (kind) {
    case 'bundled':
      return (
        'Bundled packs are tied to the installed CLI version — upgrading the CLI implicitly ' +
        'upgrades the pack. update-pack revalidates and seeds refs the pack gained; user ' +
        'overrides preserved.'
      );
    case 'package':
      return (
        'Re-resolved from project deps. If the package version changed, the resolved pack_root ' +
        'now reflects it; user overrides in evaluators[] are preserved verbatim.'
      );
    case 'path':
      return (
        'Path-sourced pack re-validated against the local directory. update-pack is a sync check; ' +
        'you (the user) own any content updates to a forked pack.'
      );
  }
}

function formatErrors(validation: PackValidationResult): string {
  return validation.errors
    .map((e) => `  - [${e.code}] ${e.message}${e.evaluator_id ? ` (${e.evaluator_id})` : ''}`)
    .join('\n');
}

function formatHumanResult(r: UpdatePackResult): string {
  const lines: string[] = [];
  lines.push(`Pack "${r.pack_id}" (${r.source_kind}) revalidated.`);
  lines.push(`  pack_root: ${r.pack_root}`);
  lines.push(`  ${r.note}`);
  const seededCount = r.evaluators_seeded.length + r.evaluators_seeded_disabled.length;
  if (seededCount > 0) {
    lines.push('');
    lines.push(`Seeded ${seededCount} new evaluator ref(s) the pack gained since registration:`);
    for (const ref of r.evaluators_seeded) lines.push(`  + ${ref} (enabled)`);
    for (const ref of r.evaluators_seeded_disabled) {
      lines.push(`  + ${ref} (disabled — enable explicitly via ${EVALUATOR_CONFIG_FILE})`);
    }
  }
  if (r.warnings.length > 0) {
    lines.push('');
    lines.push('Trust-boundary warnings:');
    for (const w of r.warnings) {
      lines.push(`  - ${w.message}`);
    }
  }
  lines.push('');
  return lines.join('\n');
}
