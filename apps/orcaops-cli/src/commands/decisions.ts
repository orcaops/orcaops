import { CliExit } from '../io/exit.js';
import { emitError, emitOk, writeErrorLine, writeTerminalSafeStdout } from '../io/output.js';
import { resolveDatabaseHistoryCommandContext } from '../lib/database-history-context.js';
import {
  type ArtifactDecisions,
  type DatabaseInsightContext,
  type DatabaseInsightOptions,
  formatDatabaseInsightCompleteness,
  readDatabaseDecisions,
  validateDatabaseInsight,
} from '../lib/database-insights.js';
import { closeFailedHistoryRead } from '../lib/history-reader-close.js';
import { historyScopeCommandError } from '../lib/history-scope-error.js';
import { importedTag } from '../lib/imported-provenance.js';
import { splitEvidenceCitation } from './seed/enrichment.js';

export type DecisionsOptions = DatabaseInsightOptions;

export function createDecisionsAction(dependencies: {
  openContext(options: ReturnType<typeof validateDatabaseInsight>): Promise<DatabaseInsightContext>;
}) {
  return async (options: DecisionsOptions = {}): Promise<void> => {
    const json = options.json === true;
    try {
      const prepared = validateDatabaseInsight('decisions', options);
      const context = await dependencies.openContext(prepared);
      let result: ReturnType<typeof readDatabaseDecisions>;
      try {
        result = readDatabaseDecisions(context, prepared);
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

export const decisionsAction = createDecisionsAction({
  openContext: ({ selector, profile }) =>
    resolveDatabaseHistoryCommandContext({ selector, profile }),
});

function formatHuman(artifacts: ArtifactDecisions[]): string {
  if (artifacts.length === 0) return 'No decisions in available history.\n';
  const lines: string[] = [];
  for (const a of artifacts) {
    const imported = a.origin === 'git-import';
    lines.push(
      `[${a.project_id}] ${a.artifact_id}  ${importedTag(a.origin)}${a.label} (${a.branch})`
    );
    if (imported) {
      lines.push('  origin: imported from git history (synthesized — evidence-cited paraphrases)');
    }
    for (const r of a.records) {
      const provenance =
        r.source === 'plan'
          ? `plan r${r.revision_n}`
          : r.source === 'checkpoint'
            ? `cp #${r.checkpoint_n}`
            : 'summary (deferred)';
      lines.push(`  [${r.ts ?? 'unknown ts'}] (${provenance}) ${r.decision}`);
      const citation =
        imported && r.evidence?.kind === 'git-commit'
          ? {
              prose: r.reason ?? '',
              sha: r.evidence.commit_sha.slice(0, 7),
              quote: r.evidence.quote,
            }
          : imported && r.reason !== null
            ? splitEvidenceCitation(r.reason)
            : null;
      if (citation) {
        if (citation.prose.length > 0) lines.push(`      reason: ${citation.prose}`);
        lines.push(`      evidence: commit ${citation.sha} — "${citation.quote}"`);
      } else if (r.reason) {
        lines.push(`      reason: ${r.reason}`);
      }
      for (const alt of r.alternatives_considered ?? []) {
        lines.push(`      rejected: ${alt.option} — ${alt.rejected_because}`);
      }
    }
    lines.push('');
  }
  return lines.join('\n');
}

export {
  collectArtifactDecisions,
  recordWindowFromFlags,
  type DecisionRecord,
  type CollectDecisionsInput,
  type RecordWindow,
} from '../lib/history-views.js';
