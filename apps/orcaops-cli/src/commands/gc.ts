import path from 'node:path';

import {
  applyDatabaseGitReclamation,
  inspectDatabaseMaintenance,
  readRegisteredDatabaseContext,
  resumeDatabaseGitReclamation,
} from '@orcaops/core/history/database-retention';
import { uuidv7 } from '@orcaops/storage';
import { normalizeHistoryRoot } from '@orcaops/storage/history/authority';
import {
  openProjectDatabase,
  ProjectDatabaseError,
  readProjectGitReclamationAdmission,
} from '@orcaops/storage/history/database';

import { OrcaopsError } from '../io/errors.js';
import { CliExit } from '../io/exit.js';
import { emitError, emitOk, writeErrorLine, writeTerminalSafeStdout } from '../io/output.js';
import { closeFailedHistoryRead } from '../lib/history-reader-close.js';
import {
  getInvocationCwd,
  getInvocationEnv,
  getInvocationRootOverride,
} from '../lib/invocation-context.js';

export interface GcOptions {
  projectId?: string;
  apply?: boolean;
  json?: boolean;
}

interface GcCounts {
  git_publications: number;
  operations: number;
  removed: number;
  absent: number;
  replayed: number;
}

const emptyCounts = (): GcCounts => ({
  git_publications: 0,
  operations: 0,
  removed: 0,
  absent: 0,
  replayed: 0,
});

type GcDependencies = {
  readContext: typeof readRegisteredDatabaseContext;
  openDatabase: typeof openProjectDatabase;
  inspect: typeof inspectDatabaseMaintenance;
  apply: typeof applyDatabaseGitReclamation;
  resume: typeof resumeDatabaseGitReclamation;
};

function inspectionOutput(
  inspection: Awaited<ReturnType<typeof inspectDatabaseMaintenance>> | null
) {
  return {
    project_id: inspection?.authority.projectId ?? null,
    store_instance_id: inspection?.authority.storeInstanceId ?? null,
    completeness: inspection
      ? {
          complete: inspection.completeness.complete,
          issues: inspection.completeness.issues.map((issue) => ({
            code: issue.code,
            message: issue.message,
            resource_id: issue.resourceId,
          })),
        }
      : { complete: true, issues: [] },
    resources:
      inspection?.resources.map((resource) => ({
        publication_id: resource.publicationId,
        original_operation_id: resource.originalOperationId,
        full_ref: resource.fullRef,
        expected_oid: resource.expectedOid,
        observed_oid: resource.observedOid,
        symbolic_target: resource.symbolicTarget,
        state: resource.state,
        reason: resource.reason,
        admission_operation_id: resource.admissionOperationId,
      })) ?? [],
    pending_reclamations:
      inspection?.pendingAdmissions.map((admission) => ({
        admission_operation_id: admission.admissionOperationId,
        terminal_operation_id: admission.terminalOperationId,
        publication_id: admission.target.publicationId,
        original_operation_id: admission.target.originalOperationId,
        full_ref: admission.target.fullRef,
        expected_oid: admission.target.objectOid,
      })) ?? [],
  };
}

function applyFailure(
  cause: unknown,
  completed: GcCounts,
  kind: 'pending_reclamation' | 'git_publication' | 'inspection',
  id: string,
  recoverability?: 'pending' | 'settled' | 'unknown'
): never {
  const priorCompletion = completed.git_publications > 0;
  const gc_progress = {
    state:
      recoverability === 'pending'
        ? ('recoverable_in_progress' as const)
        : priorCompletion
          ? ('partial_completion' as const)
          : ('refused' as const),
    completed: { ...completed },
    ...(recoverability ? { recoverability } : {}),
    failed_candidate: { kind, id },
  };
  const message = cause instanceof Error ? cause.message : String(cause);
  throw new OrcaopsError(
    cause instanceof ProjectDatabaseError ? cause.code : 'GC_APPLY_FAILED',
    `Garbage collection stopped at ${kind} ${id}: ${message}`,
    undefined,
    {
      ...(cause instanceof ProjectDatabaseError && cause.reason ? { reason: cause.reason } : {}),
      gc_progress,
    }
  );
}

function admissionRecoverability(
  handle: Awaited<ReturnType<typeof openProjectDatabase>>,
  admissionOperationId: string
): 'pending' | 'settled' | 'unknown' {
  try {
    const record = readProjectGitReclamationAdmission(handle, admissionOperationId).value;
    return record && !record.terminal ? 'pending' : 'settled';
  } catch {
    return 'unknown';
  }
}

function recordOutcome(
  completed: GcCounts,
  publications: Set<string>,
  publicationId: string,
  result: { value: { outcome: 'removed' | 'absent' }; replayed: boolean }
): void {
  publications.add(publicationId);
  completed.git_publications = publications.size;
  completed.operations += 1;
  completed[result.value.outcome] += 1;
  if (result.replayed) completed.replayed += 1;
}

function formatHuman(
  applied: boolean,
  output: ReturnType<typeof inspectionOutput>,
  wouldReclaim: number,
  deleted: GcCounts
): string {
  const lines = [
    applied ? 'orcaops gc — applied' : 'orcaops gc — dry-run (pass --apply to reclaim)',
    `  project:               ${output.project_id ?? '(unregistered)'}`,
    `  completeness:          ${output.completeness.complete ? 'complete' : 'incomplete'}`,
    `  reclaimable:           ${wouldReclaim}`,
    `  protected:             ${output.resources.filter((item) => item.state === 'protected').length}`,
    `  pending reclamations:  ${output.pending_reclamations.length}`,
    `  publication outcomes:  ${deleted.git_publications}`,
    `  operations observed:   ${deleted.operations} (${deleted.replayed} replayed)`,
  ];
  for (const resource of output.resources)
    lines.push(
      `  ${resource.state.padEnd(9)} ${resource.full_ref} (${resource.reason}; observed ${resource.observed_oid ?? 'absent'})`
    );
  if (!output.project_id)
    lines.push('  No registered canonical project history was found; nothing was created.');
  return lines.join('\n') + '\n';
}

export function createDatabaseGcAction(dependencies: GcDependencies) {
  return async (received: GcOptions = {}): Promise<void> => {
    const options = { ...received };
    const json = options.json === true;
    const controller = new AbortController();
    const interrupt = () => controller.abort();
    process.on('SIGINT', interrupt);
    let reader: Awaited<ReturnType<typeof openProjectDatabase>> | null = null;
    let writer: Awaited<ReturnType<typeof openProjectDatabase>> | null = null;
    try {
      const invocationCwd = getInvocationCwd();
      const env = { ...getInvocationEnv() };
      const override = getInvocationRootOverride() ?? env.ORCAOPS_ROOT;
      const cwd = override?.trim() ? path.resolve(invocationCwd, override) : invocationCwd;
      const root = await normalizeHistoryRoot({ cwd: invocationCwd, env });
      const context = await dependencies.readContext(
        { cwd, root: root.resolvedRoot, projectId: options.projectId },
        { signal: controller.signal }
      );
      if (!context) {
        const output = inspectionOutput(null);
        if (json)
          emitOk({
            schema_version: 1,
            applied: options.apply === true,
            ...output,
            would_reclaim: 0,
            deleted: emptyCounts(),
          });
        else writeTerminalSafeStdout(formatHuman(options.apply === true, output, 0, emptyCounts()));
        return;
      }

      reader = await dependencies.openDatabase({
        authority: context.authority,
        mode: 'reader',
        signal: controller.signal,
      });
      let inspection = await dependencies.inspect(reader, context);
      reader.close();
      reader = null;
      if (!inspection.completeness.complete && options.apply)
        throw new ProjectDatabaseError(
          'HISTORY_INACCESSIBLE',
          'Managed Git namespace inspection is incomplete; preserve every ref and repair access before applying garbage collection'
        );

      const initial = inspectionOutput(inspection);
      const wouldReclaim = inspection.resources.filter(
        (resource) => resource.state === 'eligible'
      ).length;
      const deleted = emptyCounts();
      const completedPublications = new Set<string>();
      if (options.apply && (wouldReclaim > 0 || inspection.pendingAdmissions.length > 0)) {
        writer = await dependencies.openDatabase({
          authority: context.authority,
          mode: 'writer',
          signal: controller.signal,
        });
        for (const admission of inspection.pendingAdmissions) {
          const resource = inspection.resources.find(
            (item) =>
              item.publicationId === admission.target.publicationId && item.state === 'eligible'
          );
          if (!resource) continue;
          try {
            const result = await dependencies.resume(
              writer,
              context,
              admission.admissionOperationId,
              { signal: controller.signal }
            );
            recordOutcome(deleted, completedPublications, admission.target.publicationId, result);
          } catch (cause) {
            applyFailure(
              cause,
              deleted,
              'pending_reclamation',
              admission.admissionOperationId,
              admissionRecoverability(writer, admission.admissionOperationId)
            );
          }
        }

        try {
          inspection = await dependencies.inspect(writer, context);
          if (!inspection.completeness.complete)
            throw new ProjectDatabaseError(
              'HISTORY_INACCESSIBLE',
              'Managed Git namespace changed to an incomplete state; preserve every remaining ref and repair access before retrying'
            );
        } catch (cause) {
          applyFailure(cause, deleted, 'inspection', 'managed_git_namespace');
        }
        for (const resource of inspection.resources) {
          if (resource.state !== 'eligible' || !resource.target) continue;
          const admission = {
            admissionOperationId: uuidv7(),
            terminalOperationId: uuidv7(),
            target: resource.target,
          };
          try {
            const result = await dependencies.apply(writer, context, admission, {
              signal: controller.signal,
            });
            recordOutcome(deleted, completedPublications, resource.publicationId!, result);
          } catch (cause) {
            applyFailure(
              cause,
              deleted,
              'git_publication',
              resource.publicationId!,
              admissionRecoverability(writer, admission.admissionOperationId)
            );
          }
        }
      }
      writer?.close();
      writer = null;

      if (json)
        emitOk({
          schema_version: 1,
          applied: options.apply === true,
          ...initial,
          would_reclaim: wouldReclaim,
          deleted,
        });
      else
        writeTerminalSafeStdout(
          formatHuman(options.apply === true, initial, wouldReclaim, deleted)
        );
    } catch (cause) {
      if (reader) closeFailedHistoryRead(reader);
      if (writer) closeFailedHistoryRead(writer);
      if (json) emitError(cause);
      else writeErrorLine(cause);
      throw new CliExit(1);
    } finally {
      process.off('SIGINT', interrupt);
    }
  };
}

export const gcAction = createDatabaseGcAction({
  readContext: readRegisteredDatabaseContext,
  openDatabase: openProjectDatabase,
  inspect: inspectDatabaseMaintenance,
  apply: applyDatabaseGitReclamation,
  resume: resumeDatabaseGitReclamation,
});
