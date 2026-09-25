import Database from 'better-sqlite3';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { EventType } from '../src/events/event-log.js';
import {
  appendProjectArtifactEvents,
  prepareArtifactAppend,
  prepareArtifactAppendRequest,
  readProjectArtifact,
} from '../src/history/database/artifacts.js';
import {
  initializeProjectDatabase,
  openProjectDatabase,
  type ProjectDatabase,
  projectDatabasePath,
} from '../src/history/database/connection.js';
import {
  type ProcessingAttemptPermission,
  readLatestProcessingModelConfirmation,
  recordProcessingModelConfirmation,
} from '../src/history/database/processing-confirmations.js';
import { processingDispatchContext } from '../src/history/database/processing-dispatch-context.js';
import {
  admitProcessingJob,
  type ProcessingAdmission,
} from '../src/history/database/processing-jobs.js';
import { readProcessingJob } from '../src/history/database/processing-reader.js';
import { runProjectOperation } from '../src/history/database/transactions.js';
import { recordChecksum } from '../src/history/event-integrity.js';
import { normalizeHistoryRoot } from '../src/history/paths.js';
import { uuidv7 } from '../src/ids/uuidv7.js';
import type { SourcePublicationPath } from '../src/schema/knowledge-contract.js';

export const PROCESSOR_CONTRACT = 'knowledge-interpretation@2';

export interface ProcessingCapture {
  /** The identity of the capture-shaped operation that published and admitted. */
  operationId: string;
  /** The plan event this capture settled, and the job's source. */
  eventId: string;
  jobId: string;
  admission: ProcessingAdmission;
}

export interface ProcessingCaptureInput {
  jobId?: string;
  processorContract?: string;
  withoutModel?: boolean;
  path?: SourcePublicationPath;
  originKind?: 'captured' | 'git-import' | null;
  settledEventTypes?: readonly EventType[];
  derivedByProcessing?: boolean;
  admittedAt?: string;
  /** Admit against an event published earlier instead of the one this capture adds. */
  sourceEventId?: string;
  /** Refuse after the settlement has written, to watch both halves roll back. */
  refuseAfterSettlement?: boolean;
}

export interface ProcessingSnapshot {
  operations: { operation_id: string }[];
  writeSequence: number;
  intentChangeCounter: number;
  jobs: unknown[];
  attempts: unknown[];
  usage: unknown[];
  lease: unknown[];
  control: unknown[];
  confirmations: unknown[];
  reopenings: unknown[];
}

export function processingAttemptPermission(
  handle: ProjectDatabase,
  jobId: string,
  grantId = 'grant-1',
  bounds: {
    maxAttempts?: number;
    maxCallsPerHour?: number;
    maxCostUsdPerDay?: number | null;
    reservationUsd?: number | null;
  } = {}
): ProcessingAttemptPermission {
  const job = readProcessingJob(handle, jobId);
  if (job === null) throw new Error(`missing fixture job ${jobId}`);
  const confirmation = handle.read((view) =>
    readLatestProcessingModelConfirmation(view, jobId)
  ).value;
  const executionTerms: ProcessingAttemptPermission['execution_terms'] = {
    v: 1,
    project_id: handle.authority.projectId,
    job_id: job.jobId,
    source: job.source,
    origin: { worktree_root: handle.authority.resolvedRoot },
    processor_contract: job.processorContract,
    provider: { id: 'claude', selection: 'explicit' },
    model: { selection: 'explicit', id: 'fixture-model' },
    effort: { selection: 'provider_default', value: null },
    tool_access: 'none',
    limits: {
      max_cost_usd_per_call:
        bounds.maxCostUsdPerDay == null
          ? 'none'
          : { usd: bounds.reservationUsd ?? 0, holds: 'ceiling' },
      max_cost_usd_per_day: bounds.maxCostUsdPerDay ?? 'none',
      max_calls_per_hour: bounds.maxCallsPerHour ?? 60,
      max_input_bytes: 131072,
      max_output_bytes: 131072,
    },
    output_token_cap: { kind: 'none' },
    timeout_ms: 120000,
    max_attempts: bounds.maxAttempts ?? 3,
  };
  return {
    v: 1,
    confirmation_id: confirmation?.confirmationId ?? null,
    confirmed_terms: confirmation?.terms ?? null,
    execution_terms: executionTerms,
    attempt_grant_id: grantId,
  };
}

export function processingAttemptConfiguration(
  handle: ProjectDatabase,
  jobId: string,
  extra: Record<string, unknown> = {},
  grantId = 'grant-1',
  bounds: Parameters<typeof processingAttemptPermission>[3] = {}
) {
  return { ...extra, permission: processingAttemptPermission(handle, jobId, grantId, bounds) };
}

function planPayload(artifactId: string, revision: number, priorEventId: string | null) {
  return {
    schema_version: 4,
    artifact_id: artifactId,
    branch: 'main',
    base_sha: 'original base',
    agent: 'codex',
    agent_session_id: null,
    task: 'Interpret the captured plan',
    label: 'Captured plan',
    plan_steps: [
      {
        step_id: uuidv7(),
        text: 'Retain the original capture',
        label: 'Original capture',
        acceptance_criteria: [],
      },
    ],
    touched_scope: [],
    non_goals: [],
    decisions: [],
    started_at: '2026-09-01T00:00:00Z',
    revision_n: revision,
    revised_at: revision === 0 ? null : `2026-09-01T00:0${revision}:00Z`,
    rationale: revision === 0 ? null : 'Restate the plan',
    step_lineage: { added: [], dropped: [], unchanged: [], rewritten: [] },
    criterion_lineage: { added: [], carried: [], removed: [], rewritten: [] },
    prior_plan_event_id: priorEventId,
  };
}

function planEvent(artifactId: string, revision: number, priorEventId: string | null) {
  const event = {
    event_id: uuidv7(),
    type: revision === 0 ? 'plan_captured' : 'plan_revised',
    ts: '2026-09-01T00:00:00Z',
    schema_version: 1,
    idempotency_key: uuidv7(),
    payload: planPayload(artifactId, revision, priorEventId),
  };
  return {
    eventId: event.event_id,
    type: event.type as EventType,
    bytes: Buffer.from(JSON.stringify({ ...event, checksum: recordChecksum(event) }) + '\n'),
  };
}

/**
 * A real project database in a temporary root with one captured artifact, plus
 * a capture-shaped operation that publishes a plan event and admits a
 * processing job for it in the same transaction.
 */
export async function processingFixture() {
  const root = await normalizeHistoryRoot({
    root: await mkdtemp(path.join(tmpdir(), 'processing-storage-')),
  });
  const authority = {
    ...root,
    projectId: uuidv7(),
    storeInstanceId: uuidv7(),
    repositoryInstanceId: uuidv7(),
  };
  const file = projectDatabasePath(authority);
  await mkdir(path.dirname(file), { recursive: true });
  const handle = await initializeProjectDatabase({
    authority,
    initializationOperationId: uuidv7(),
    initializedAt: '2026-09-01T00:00:00Z',
    authorize() {},
  });
  const handles: ProjectDatabase[] = [handle];
  const artifactId = uuidv7();
  const first = planEvent(artifactId, 0, null);
  await appendProjectArtifactEvents(handle, {
    operationId: uuidv7(),
    artifactId,
    expectedRevision: null,
    eventBytes: first.bytes,
    sidecarPayloads: [],
    secretAllow: [],
  });
  let revision = 0;
  let priorEventId = first.eventId;

  async function capture(input: ProcessingCaptureInput = {}): Promise<ProcessingCapture> {
    const operationId = uuidv7();
    const jobId = input.jobId ?? uuidv7();
    revision += 1;
    const next = planEvent(artifactId, revision, priorEventId);
    const request = prepareArtifactAppendRequest({
      artifactId,
      operationId,
      expectedRevision: readProjectArtifact(handle, artifactId)!.revision,
      eventBytes: next.bytes,
      sidecarPayloads: [],
      secretAllow: [],
    });
    const append = await prepareArtifactAppend(handle, request);
    const sourceEventId = input.sourceEventId ?? next.eventId;
    let admission: ProcessingAdmission = { outcome: 'not_eligible' };
    try {
      await runProjectOperation(
        handle,
        { ...request.operation, kind: 'fixture.capture.settle' },
        (transaction) => {
          append.settle(transaction);
          admission = admitProcessingJob(
            transaction,
            {
              jobId,
              identity: {
                source: { kind: 'capture_event', event_id: sourceEventId },
                processor_contract: input.processorContract ?? PROCESSOR_CONTRACT,
              },
              path: input.path ?? 'live_capture_settlement',
              originKind: input.originKind === undefined ? 'captured' : input.originKind,
              settledEventTypes: input.settledEventTypes ?? [next.type],
              derivedByProcessing: input.derivedByProcessing ?? false,
              withoutModel: input.withoutModel ?? false,
              admittedAt: input.admittedAt ?? '2026-09-01T00:00:00.000Z',
              context: processingDispatchContext({
                artifactId,
                worktreeRoot: authority.resolvedRoot,
              }),
            },
            operationId
          );
          if (input.refuseAfterSettlement)
            throw new Error('fixture refusal after the settlement wrote');
          return { eventId: next.eventId };
        }
      );
    } catch (cause) {
      revision -= 1;
      throw cause;
    }
    priorEventId = next.eventId;
    return { operationId, eventId: next.eventId, jobId, admission };
  }

  async function confirm(jobId: string, confirmedAt = '2026-09-01T00:00:00.000Z') {
    const permission = processingAttemptPermission(handle, jobId);
    const previous = handle.read((view) =>
      readLatestProcessingModelConfirmation(view, jobId)
    ).value;
    return recordProcessingModelConfirmation(handle, {
      confirmationId: uuidv7(),
      jobId,
      expectedPreviousSequence: previous?.confirmationSequence ?? null,
      confirmedAt,
      confirmedBy: 'owner@example.test',
      confirmedByBasis: 'authenticated',
      grantId: 'grant-1',
      terms: permission.execution_terms,
    });
  }

  function snapshot(): ProcessingSnapshot {
    const read = handle.read((view) => ({
      operations: view.all<{ operation_id: string }>(
        'SELECT operation_id FROM operations ORDER BY operation_id'
      ),
      jobs: view.all('SELECT * FROM processing_jobs ORDER BY job_id'),
      attempts: view.all('SELECT * FROM processing_attempts ORDER BY attempt_id'),
      usage: view.all('SELECT * FROM processing_usage ORDER BY usage_id'),
      lease: view.all('SELECT * FROM processing_lease'),
      control: view.all('SELECT * FROM processing_control'),
      confirmations: view.all(
        'SELECT * FROM processing_model_confirmations ORDER BY job_id, confirmation_sequence'
      ),
      reopenings: view.all(
        'SELECT * FROM processing_job_reopenings ORDER BY job_id, reopening_sequence'
      ),
    }));
    return {
      ...read.value,
      writeSequence: read.counters.writeSequence,
      intentChangeCounter: read.counters.intentChangeCounter,
    };
  }

  return {
    handle,
    authority,
    artifactId,
    planEventId: first.eventId,
    databasePath: file,
    capture,
    confirm,
    snapshot,
    /** Direct driver access for row assertions and cross-process fixtures. */
    driver() {
      const db = new Database(file);
      db.pragma('foreign_keys=ON');
      return db;
    },
    async open(mode: 'reader' | 'writer' = 'writer') {
      const value = await openProjectDatabase({ authority, mode });
      handles.push(value);
      return value;
    },
    async close() {
      for (const value of handles.splice(0)) {
        try {
          value.close();
        } catch {
          /* A closed or poisoned connection cannot block temporary cleanup. */
        }
      }
      await rm(root.resolvedRoot, { recursive: true, force: true });
    },
  };
}

export const NOW = '2026-09-01T12:00:00.000Z';
export const later = (base: string, milliseconds: number) =>
  new Date(Date.parse(base) + milliseconds).toISOString();
