import { CliExit } from '../io/exit.js';
import { emitError, emitOk, writeErrorLine, writeTerminalSafeStdout } from '../io/output.js';
import { resolveDatabaseHistoryCommandContext } from '../lib/database-history-context.js';
import {
  type ArtifactLooseEndsView,
  type DatabaseInsightContext,
  type DatabaseInsightOptions,
  formatDatabaseInsightCompleteness,
  readDatabaseLooseEnds,
  validateDatabaseInsight,
} from '../lib/database-insights.js';
import { closeFailedHistoryRead } from '../lib/history-reader-close.js';
import { historyScopeCommandError } from '../lib/history-scope-error.js';
import { importedTag } from '../lib/imported-provenance.js';

export type LooseEndsOptions = DatabaseInsightOptions;

export function createLooseEndsAction(dependencies: {
  openContext(options: ReturnType<typeof validateDatabaseInsight>): Promise<DatabaseInsightContext>;
}) {
  return async (options: LooseEndsOptions = {}): Promise<void> => {
    const json = options.json === true;
    try {
      const prepared = validateDatabaseInsight('loose-ends', options);
      const context = await dependencies.openContext(prepared);
      let result: ReturnType<typeof readDatabaseLooseEnds>;
      try {
        result = readDatabaseLooseEnds(context, prepared);
      } catch (cause) {
        closeFailedHistoryRead(context.scope);
        throw cause;
      }
      context.scope.close();
      if (prepared.json) emitOk(result);
      else
        writeTerminalSafeStdout(
          formatHuman(result.results) + formatDatabaseInsightCompleteness(result)
        );
    } catch (cause) {
      const error = historyScopeCommandError(cause);
      if (json) emitError(error);
      writeErrorLine(error);
      throw new CliExit(1);
    }
  };
}

export const looseEndsAction = createLooseEndsAction({
  openContext: ({ selector, profile }) =>
    resolveDatabaseHistoryCommandContext({ selector, profile }),
});

function formatHuman(artifacts: ArtifactLooseEndsView[]): string {
  if (artifacts.length === 0) return 'No loose ends in available history.\n';
  const lines: string[] = [];
  for (const a of artifacts) {
    const imported = a.origin === 'git-import';
    lines.push(
      `[${a.project_id}] ${a.artifact_id}  ${importedTag(a.origin)}${a.label} (${a.branch}) — ${a.finding_count} finding(s)`
    );
    if (imported) {
      lines.push('  origin: imported from git history (synthesized)');
    }
    for (const oi of a.open_items) lines.push(`  open item: ${oi.text}`);
    for (const dd of a.deferred_decisions) lines.push(`  deferred decision: ${dd.text}`);
    for (const u of a.uncertainty) {
      for (const e of u.entries) lines.push(`  uncertainty (cp #${u.checkpoint_n}): ${e}`);
    }
    for (const s of a.uncovered_steps) lines.push(`  uncovered step: ${s.label}`);
    for (const cp of a.open_checkpoints) {
      lines.push(`  open checkpoint #${cp.n} (opened ${cp.opened_at}, ${cp.age_seconds}s ago)`);
    }
    if (a.no_summary) lines.push('  no summary captured');
    if (a.summary_unreadable)
      lines.push('  summary unreadable — open items unknown (run `orcaops doctor`)');
    lines.push('');
  }
  return lines.join('\n');
}

export {
  collectLooseEnds,
  type LooseEndsInput,
  type ArtifactLooseEnds,
} from '../lib/history-views.js';
