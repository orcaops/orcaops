import type { ProjectDatabase } from './connection.js';
import { ProjectDatabaseError } from './errors.js';
import {
  type CaptureOperationOptions,
  prepareExecutionCaptureRequest,
  prepareExecutionCaptureSettlement,
  type ProjectCaptureResult,
  restoreExecutionCaptureRequest,
} from './execution-capture.js';
import { translateExecutionFailure } from './execution-errors.js';
import { prepareProjectImportedArtifactSettlement } from './imported-artifact.js';
import { settleProjectTaskUses } from './knowledge-task-uses.js';
import {
  assertCaptureRetentionInput,
  captureRetentionOperation,
  insertPendingCapture,
  type PendingCaptureInput,
  readProjectPendingCapture,
} from './pending-capture.js';
import type { PreparedPlanCaptureCommand } from './plan-capture-input.js';
import { preparePlanCaptureInsertion } from './plan-capture.js';
import { gitRetentionPreparation, type PreparedProjectGitRetention } from './retention-input.js';
import {
  advanceRetentionRecords,
  insertRetentionRecords,
  readRetentionRecords,
  retentionId,
} from './retention-records.js';
import {
  assertRetentionTarget,
  bindRetainedPublications,
  staleRetention,
} from './retention-targets.js';
import { isSourceTimeSnapshotChanged } from './source-time-records.js';
import { type ProjectOperationOptions, runProjectOperation } from './transactions.js';
import type { DatabaseJson } from './values.js';
import { canonicalJson } from '../../events/canonical-json.js';

async function beginCaptureRetention(
  handle: ProjectDatabase,
  input: { capture: PendingCaptureInput; retention: PreparedProjectGitRetention },
  options: CaptureOperationOptions = {},
  command?: PreparedPlanCaptureCommand,
  mode: 'capture' | 'import' = 'capture'
) {
  const runtime = { signal: options.signal, onWait: options.onWait };
  try {
    const capture = prepareExecutionCaptureRequest(handle, input.capture);
    const retention = gitRetentionPreparation(input.retention);
    assertCaptureRetentionInput(capture, retention);
    const originalOperation = captureRetentionOperation(capture, retention, mode);
    const plan = command
      ? preparePlanCaptureInsertion(command, capture, originalOperation.operationId)
      : null;
    const operation = plan
      ? {
          ...originalOperation,
          kind: 'plan.capture.retention.begin',
          payload: { capture: originalOperation.payload, command: plan.payload },
        }
      : originalOperation;
    const replay = handle.read((view) =>
      view.get('SELECT operation_id FROM operations WHERE operation_id = ?', operation.operationId)
    ).value;
    if (replay) {
      const original = readProjectPendingCapture(handle, retention.operationId).value;
      if (!original)
        throw new ProjectDatabaseError(
          'HISTORY_MISSING',
          'Original pending capture is missing; preserve history for explicit repair'
        );
      const retained = restoreExecutionCaptureRequest(handle, original.capture);
      if (
        original.mode !== mode ||
        canonicalJson(original.retention.input) !== canonicalJson(retention) ||
        canonicalJson(retained.execution) !== canonicalJson(capture.execution) ||
        retained.request.incoming.length !== capture.request.incoming.length ||
        retained.request.incoming.some((entry, index) => {
          const candidate = capture.request.incoming[index]!;
          return (
            !entry.bytes.equals(candidate.bytes) ||
            (entry.sidecar === null
              ? candidate.sidecar !== null
              : candidate.sidecar === null || !entry.sidecar.equals(candidate.sidecar))
          );
        })
      )
        throw new ProjectDatabaseError(
          'IDEMPOTENCY_CONFLICT',
          'This admission identifies different original capture input; retain its original bytes or start an explicitly new operation'
        );
    } else if (mode === 'import')
      await prepareProjectImportedArtifactSettlement(handle, input.capture);
    else await prepareExecutionCaptureSettlement(handle, capture);
    return await runProjectOperation(
      handle,
      operation,
      (tx) => {
        if (readRetentionRecords(tx, retention.operationId))
          throw new ProjectDatabaseError(
            'IDEMPOTENCY_CONFLICT',
            'Original capture already has a different admission identity; retain its original request'
          );
        assertRetentionTarget(tx, retention);
        plan?.settle(tx);
        insertRetentionRecords(tx, retention);
        insertPendingCapture(tx, capture, options.processing?.withoutModel === true);
        return {
          originalOperationId: retention.operationId,
          transitionId: retention.preparedTransitionId,
          state: 'prepared',
        };
      },
      runtime
    );
  } catch (cause) {
    throw translateExecutionFailure(cause);
  }
}

export function beginProjectCaptureRetention(
  handle: ProjectDatabase,
  input: { capture: PendingCaptureInput; retention: PreparedProjectGitRetention },
  options: CaptureOperationOptions = {}
) {
  return beginCaptureRetention(handle, input, options);
}

export function beginProjectImportedArtifactRetention(
  handle: ProjectDatabase,
  input: { capture: PendingCaptureInput; retention: PreparedProjectGitRetention },
  options: ProjectOperationOptions = {}
) {
  return beginCaptureRetention(handle, input, options, undefined, 'import');
}

export function beginProjectPlanCaptureRetention(
  handle: ProjectDatabase,
  input: {
    capture: PendingCaptureInput;
    retention: PreparedProjectGitRetention;
    command: PreparedPlanCaptureCommand;
  },
  options: CaptureOperationOptions = {}
) {
  return beginCaptureRetention(handle, input, options, input.command);
}

type RetentionSelection = {
  originalOperationId: string;
  expectedTransitionId: string;
  selectedTransitionId: string;
};
type RetentionResult = {
  originalOperationId: string;
  transitionId: string;
  state: string;
  publicationIds: string[];
};
type ArtifactResult = {
  artifactId: string;
  revision: {
    generation: number;
    orderedHash: string;
    eventCount: number;
    byteLength: number;
    tailEventId: string;
  };
  eventIds: string[];
};
type CaptureRetentionResult = RetentionResult &
  ArtifactResult & { executionVersion: number; bindingGeneration: number };
type ImportedRetentionResult = RetentionResult & ArtifactResult;

function settleCaptureRetention(
  handle: ProjectDatabase,
  input: RetentionSelection,
  options?: CaptureOperationOptions,
  mode?: 'capture'
): Promise<ProjectCaptureResult<CaptureRetentionResult>>;
function settleCaptureRetention(
  handle: ProjectDatabase,
  input: RetentionSelection,
  options: CaptureOperationOptions | undefined,
  mode: 'import'
): Promise<ProjectCaptureResult<ImportedRetentionResult>>;
function settleCaptureRetention(
  handle: ProjectDatabase,
  input: RetentionSelection,
  options: CaptureOperationOptions | undefined,
  mode: 'capture' | 'import'
): Promise<ProjectCaptureResult<CaptureRetentionResult | ImportedRetentionResult>>;
async function settleCaptureRetention(
  handle: ProjectDatabase,
  input: RetentionSelection,
  options: CaptureOperationOptions = {},
  mode: 'capture' | 'import' = 'capture'
) {
  const runtime = { signal: options.signal, onWait: options.onWait };
  const originalOperationId = input.originalOperationId;
  const expectedTransitionId = input.expectedTransitionId;
  const selectedTransitionId = input.selectedTransitionId;
  retentionId(originalOperationId);
  retentionId(expectedTransitionId);
  retentionId(selectedTransitionId);
  try {
    const original = readProjectPendingCapture(handle, originalOperationId).value;
    if (!original)
      throw new ProjectDatabaseError(
        'HISTORY_MISSING',
        'Original pending capture is missing; preserve any refs and use explicit repair'
      );
    if (original.mode !== mode)
      throw new ProjectDatabaseError(
        'INVALID_INPUT',
        `Original pending operation is not a ${mode} retention request`
      );
    const capture = restoreExecutionCaptureRequest(handle, original.capture);
    const retention = original.retention.input;
    // The staging invocation's no-model choice governs, never the one settling:
    // a capture resumed by a later invocation must not become a paid call
    // because that invocation left the flag off, nor lose a model the capture
    // was made with because it passed one.
    const processing =
      options.processing === undefined
        ? undefined
        : { ...options.processing, withoutModel: original.withoutModel };
    const planUses = original.planUses;
    const operation = {
      operationId: originalOperationId,
      kind: `${mode}.retention.select`,
      target: { originalOperationId, artifactId: capture.request.artifactId },
      payload: JSON.parse(
        canonicalJson({
          retention,
          capture: capture.operation.payload,
          selectedTransitionId,
          ...(planUses === null ? {} : { knowledge_uses: [...planUses.authoredSha256] }),
        })
      ) as DatabaseJson,
      expectedState: JSON.parse(
        canonicalJson({ target: retention.target, transitionId: expectedTransitionId })
      ) as DatabaseJson,
      intentChange: capture.operation.intentChange,
    };
    for (let attempt = 0; ; attempt++) {
      if (runtime.signal?.aborted)
        throw new ProjectDatabaseError(
          'CANCELLED',
          'Capture settlement cancelled before publication; retain the original request for an explicit retry'
        );
      const replay = handle.read((view) =>
        view.get('SELECT operation_id FROM operations WHERE operation_id = ?', originalOperationId)
      ).value;
      const settlement = replay
        ? null
        : mode === 'import'
          ? await prepareProjectImportedArtifactSettlement(handle, original.capture)
          : await prepareExecutionCaptureSettlement(handle, capture, processing);
      try {
        const result = await runProjectOperation(
          handle,
          operation,
          (tx, settling) => {
            const current = readRetentionRecords(tx, originalOperationId);
            if (!current || !settlement)
              throw new ProjectDatabaseError(
                'HISTORY_INTEGRITY_REQUIRED',
                'Original capture admission or terminal receipt disappeared; preserve history for explicit repair'
              );
            if (
              current.current.kind !== 'prepared' ||
              current.current.transitionId !== expectedTransitionId
            )
              staleRetention();
            if (canonicalJson(current.input) !== canonicalJson(retention))
              throw new ProjectDatabaseError(
                'HISTORY_INTEGRITY_REQUIRED',
                'Immutable original capture retention changed; preserve history for explicit repair'
              );
            assertRetentionTarget(tx, retention);
            const artifact = settlement.settle(tx);
            // This is the operation that writes the plan event, so it is the only one whose
            // settlement can record the uses the plan selected: written at the admission instead,
            // they would be a later connection nobody found.
            if (planUses) settleProjectTaskUses(tx, settling, planUses, null);
            const artifactResult = JSON.parse(canonicalJson(artifact)) as Record<
              string,
              DatabaseJson
            >;
            advanceRetentionRecords(tx, current, {
              transitionId: selectedTransitionId,
              kind: 'selected',
              commandOperationId: originalOperationId,
              retirementReason: null,
            });
            bindRetainedPublications(tx, retention, settlement.artifactRevision);
            return {
              ...artifactResult,
              originalOperationId,
              transitionId: selectedTransitionId,
              state: 'selected',
              publicationIds: retention.publications.map(
                (publication) => publication.publicationId
              ),
            };
          },
          runtime
        );
        return {
          ...result,
          admittedProcessingJobs:
            settlement && 'admitted' in settlement ? [...settlement.admitted] : [],
        };
      } catch (cause) {
        if (attempt !== 0 || !isSourceTimeSnapshotChanged(cause)) throw cause;
      }
    }
  } catch (cause) {
    throw translateExecutionFailure(cause);
  }
}

export function settleProjectCaptureRetention(
  handle: ProjectDatabase,
  input: RetentionSelection,
  options: CaptureOperationOptions = {}
) {
  return settleCaptureRetention(handle, input, options);
}

export function settleProjectImportedArtifactRetention(
  handle: ProjectDatabase,
  input: RetentionSelection,
  options: ProjectOperationOptions = {}
) {
  return settleCaptureRetention(handle, input, options, 'import');
}
