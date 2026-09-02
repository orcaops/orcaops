import { rebuildCache } from '@orcaops/storage';

import { CliExit } from '../io/exit.js';
import {
  emitError,
  emitOk,
  writeErrorLine,
  writeTerminalSafeStderr,
  writeTerminalSafeStdout,
} from '../io/output.js';
import { buildContext } from '../lib/context.js';

export interface RebuildOptions {
  json?: boolean;
}

/**
 * `orcaops rebuild` — drop and re-populate the SQLite cache from durable
 * artifact event logs and the usage ledger. Useful when the cache
 * is missing or suspected stale (e.g., after `rm -rf .orcaops/cache`,
 * after a schema change, or when SQLite gets out of sync with disk).
 *
 * Invariant: SQLite is a disposable projection. Rebuild retains only state
 * reconstructed from authoritative durable sources.
 */
export async function rebuildAction(opts: RebuildOptions = {}): Promise<void> {
  try {
    const ctx = await buildContext({ destructiveRebuild: true });
    try {
      // The destructive context open performs the replay under the shared
      // rebuild lease. Do not replay it a second time.
      const healed = ctx.healedProjection && ctx.healResult !== null;
      const result = healed
        ? (ctx.healResult as NonNullable<typeof ctx.healResult>)
        : await rebuildCache({
            repoRoot: ctx.repoRoot,
            config: ctx.config,
            store: ctx.store.store,
            onPlanIdempotencyConflicts: (conflicts) => {
              writeTerminalSafeStderr(
                `warning: ${conflicts.length} plan idempotency key(s) appear ` +
                  `in multiple artifacts' event logs (filesystem-level ` +
                  `corruption); the first artifact holds each key — run ` +
                  '`orcaops doctor`.\n'
              );
            },
          });

      if (opts.json) {
        emitOk({ ...result, healed_on_open: healed });
        return;
      }
      if (healed) {
        writeTerminalSafeStdout(
          'The SQLite projection was recreated or wiped and rebuilt from durable ' +
            'sources when this command opened it.\n'
        );
      }

      const lines: string[] = [];
      lines.push(`Rebuilt SQLite cache from durable sources`);
      if (result.skipped_artifacts > 0) {
        lines.push(`  SKIPPED (malformed): ${result.skipped_artifacts} — run orcaops doctor`);
      }
      lines.push(`  artifacts:         ${result.artifacts}`);
      lines.push(`  checkpoints:       ${result.checkpoints}`);
      lines.push(`  summaries:         ${result.summaries}`);
      lines.push(`  evaluator_runs:    ${result.evaluator_runs}`);
      lines.push(`  digests:           ${result.digests}`);
      lines.push(`  block_resolutions: ${result.block_resolutions}`);
      lines.push(`  pin_displaced:     ${result.pin_displaced}`);
      lines.push(`  usage_snapshots:   ${result.usage_snapshots}`);
      lines.push(`  source_plan_links: ${result.source_plan_links}`);
      lines.push('');
      writeTerminalSafeStdout(lines.join('\n'));
    } finally {
      ctx.store.close();
    }
  } catch (err) {
    if (opts.json) emitError(err);
    writeErrorLine(err);
    throw new CliExit(1);
  }
}
