import { resolveCloudTarget, resolveCredentialStore } from '@orcaops/core';
import { HistoryScopeError } from '@orcaops/project-scope/history';
import { HistoryError } from '@orcaops/storage/history/authority';
import {
  type ProjectDatabase,
  readProjectArtifact,
  readProjectExecution,
} from '@orcaops/storage/history/database';
import { historyMetadataDetails } from '@orcaops/storage/history/metadata-row';

import type { DatabaseCaptureCommandContext } from './database-capture-context.js';
import { databaseTaskActions, openCheckpointCriterionIds } from './database-task-context.js';
import { discoverEvaluatorsForCli } from './evaluator-discovery.js';
import { getInvocationCloudBaseUrl } from './invocation-context.js';
import { buildAcknowledgeByRef } from './next-actions.js';
import { OrcaopsError } from '../io/errors.js';
import { scrubOutboundText } from '../io/output.js';

/** Scope and authority failures carry their own codes; the capture envelope renders them unchanged. */
export function translateDatabaseCaptureError(cause: unknown): unknown {
  return cause instanceof HistoryScopeError || cause instanceof HistoryError
    ? new OrcaopsError(cause.code, scrubOutboundText(cause.message))
    : cause;
}

/** Next-step hints are advisory: any failure yields no hints rather than failing the capture. */
export async function databaseCaptureNextActions(
  context: DatabaseCaptureCommandContext,
  handle: ProjectDatabase,
  artifactId: string,
  options: { offerPlanApproval?: boolean } = {}
) {
  try {
    const retained = readProjectArtifact(handle, artifactId);
    const execution = readProjectExecution(handle, artifactId);
    if (!retained?.thread.artifactJson || !retained.thread.plan) return [];
    let acknowledgeByRef: (ref: string) => boolean = () => false;
    try {
      acknowledgeByRef = buildAcknowledgeByRef(
        (await discoverEvaluatorsForCli(context.registered.git.worktreeRoot)).evaluators
      );
    } catch {
      // Broken evaluator configuration never grants acknowledgment eligibility.
    }
    const actions = databaseTaskActions(
      artifactId,
      retained.thread.artifactJson.state,
      retained.thread.checkpoints.length,
      historyMetadataDetails(retained.thread, execution?.state ?? null),
      context.registered.git.headOid ?? '',
      acknowledgeByRef,
      openCheckpointCriterionIds(retained.thread)
    );
    const sourceKind = retained.thread.artifactJson.source_plan?.source_ref.kind;
    if (options.offerPlanApproval && sourceKind !== 'cloud') {
      try {
        const credentials = resolveCredentialStore();
        const target = resolveCloudTarget(getInvocationCloudBaseUrl());
        if (await credentials.read(target))
          actions.push({
            verb: 'plan-approval',
            command: 'orcaops plan upload <plan-file> --json',
            effect:
              'This machine is cloud-connected and the plan is not pinned to a reviewed cloud ' +
              'version. To route it through web approval, upload it, then follow the ' +
              'plan-approval skill to pull the approved version and re-capture with ' +
              '--source-plan cloud:<id>@<n>.',
          });
      } catch {
        // Credential access controls this optional hint, not the retained lifecycle actions.
      }
    }
    return actions;
  } catch {
    return [];
  }
}
