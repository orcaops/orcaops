import {
  type ConsequenceAnswer,
  type ConsequenceBounds,
  type ConsequenceLimit,
  type KnowledgeProcessingCoverage,
  traceConsequences,
} from '@orcaops/core';
import type { AuthorityScope } from '@orcaops/storage';
import { knowledgeReadRequest } from '@orcaops/storage/history/database';

import { ErrorCodes, OrcaopsError } from '../../io/errors.js';
import { CliExit } from '../../io/exit.js';
import { emitError, emitOk, writeErrorLine, writeTerminalSafeStdout } from '../../io/output.js';
import { resolveDatabaseHistoryCommandContext } from '../../lib/database-history-context.js';
import { readConsequenceFacts } from '../../lib/knowledge-consequences-facts.js';
import { formatKnowledgeConsequences } from '../../lib/knowledge-consequences-output.js';
import {
  type AskedChange,
  askedChange,
  consequenceBounds,
  consequenceChangesOf,
  knowledgeBoundaryAsked,
} from '../../lib/knowledge-consequences-request.js';
import { processingCoverageOf } from '../../lib/knowledge-processing-coverage.js';
import { readProjectProcessingHistory } from '../../lib/knowledge-processing-queue.js';

export interface KnowledgeConsequencesOptions {
  identity?: string;
  revision?: string;
  touching?: string;
  since?: string;
  atBoundary?: string;
  depth?: string;
  limit?: string;
  json?: boolean;
}

export interface KnowledgeConsequencesReport {
  basis: {
    scope: AuthorityScope;
    mode: 'current' | 'historical';
    knowledge_boundary: number;
    bounds: ConsequenceBounds;
  };
  /** One per change traversed: one for a named identity, revision or path; many for `--since`. */
  answers: readonly ConsequenceAnswer[];
  /** What this report as a whole could not reach, apart from each answer's own limits. */
  limits: readonly ConsequenceLimit[];
  coverage: { processing: KnowledgeProcessingCoverage | null };
}

/**
 * `orcaops knowledge consequences` — what else this history records reaching from one change, at a
 * knowledge boundary the answer names.
 *
 * A passive read: it asks nothing, writes nothing, repairs nothing, opens no defect and starts no
 * worker. It never says that impact coverage is complete, and reaching an item is never a finding
 * that the item is wrong.
 */
export async function knowledgeConsequencesAction(
  opts: KnowledgeConsequencesOptions = {}
): Promise<void> {
  try {
    const asked = askedChange(opts);
    const bounds = consequenceBounds(opts);
    const boundary = knowledgeBoundaryAsked(opts.atBoundary);
    const report = await readConsequences({ asked, bounds, boundary });
    if (opts.json === true) {
      emitOk({ ...report });
      return;
    }
    writeTerminalSafeStdout(formatKnowledgeConsequences(report));
  } catch (err) {
    if (opts.json === true) emitError(err);
    writeErrorLine(err);
    throw new CliExit(1);
  }
}

async function readConsequences(input: {
  asked: AskedChange;
  bounds: ConsequenceBounds;
  boundary: number | 'now';
}): Promise<KnowledgeConsequencesReport> {
  const context = await resolveDatabaseHistoryCommandContext({
    profile: 'status',
    selector: { scope: 'project' },
  });
  try {
    const project = context.scope.projects[0];
    const authority = project?.authority ?? null;
    if (!project?.database || authority === null)
      throw new OrcaopsError(
        ErrorCodes.UNINITIALIZED,
        project?.completeness.issues[0]?.message ??
          'This repository has no orcaops project history to trace consequences in yet.'
      );
    const scope: AuthorityScope = { kind: 'project', project_id: authority.projectId };
    const mode = input.boundary === 'now' ? ('current' as const) : ('historical' as const);
    // Configuration says whether the workload is on and the queue says what it interpreted. No
    // provider is resolved: probing for one spawns subprocesses on a passive read, and neither a
    // pause reason nor a consent decision can change the claim.
    const history = readProjectProcessingHistory(project.database);
    const processing = processingCoverageOf({
      enabled: context.config.knowledge_processing.enabled,
      source: {
        kind: context.configSource?.kind ?? 'none',
        path: context.configSource?.configPath ?? '',
      },
      history,
      consent: null,
      boundary: history.boundary,
    });
    return project.database.read((view) => {
      const request = knowledgeReadRequest(view, { scope, mode, boundary: input.boundary });
      const { changes, limits } = consequenceChangesOf(view, input.asked, request, input.bounds);
      return {
        basis: {
          scope,
          mode,
          knowledge_boundary: request.knowledge_boundary,
          bounds: input.bounds,
        },
        answers: changes.map((change) =>
          traceConsequences(
            change,
            readConsequenceFacts(view, {
              projectId: authority.projectId,
              scope,
              boundary: request.knowledge_boundary,
              mode,
              change,
              bounds: input.bounds,
              processing,
            }),
            input.bounds
          )
        ),
        limits,
        coverage: { processing },
      } satisfies KnowledgeConsequencesReport;
    }).value;
  } finally {
    context.scope.close();
  }
}
