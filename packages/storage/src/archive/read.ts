import { readdir } from 'node:fs/promises';

import { archiveArtifactPaths, archiveUsageLedgerPaths } from './paths.js';
import { readEventLog } from '../events/event-log.js';
import {
  type EventWithPayload,
  loadEventsWithPayloads,
  rebuildAllCheckpointsFromEvents,
  rebuildArtifactJsonFromEvents,
  rebuildEvaluatorLogFromEvents,
  rebuildPlanFromEvents,
  rebuildSummaryFromEvents,
} from '../events/rebuilders.js';
import type { ArtifactJson } from '../schema/artifact-json.js';
import type { Checkpoint } from '../schema/checkpoint.js';
import type { EvaluatorLog } from '../schema/evaluator-run.js';
import type { Plan } from '../schema/plan.js';
import type { Summary } from '../schema/summary.js';
import { type LoadedUsageEvent, readUsageLedger } from '../usage/ledger-log.js';

/**
 * Read an archived artifact back into in-memory projections.
 * The archive deliberately holds NO projection files — events.ndjson +
 * sidecars are the whole record — so every read rebuilds through the same
 * rebuilders the hot store's recovery path uses. This is the seam the
 * global-index ingest, `decisions/loose-ends --all-projects`, and the
 * resume-from-archive restore all share.
 */
export interface ArchivedArtifactThread {
  artifactId: string;
  events: EventWithPayload[];
  plan: Plan | null;
  checkpoints: Checkpoint[];
  summary: Summary | null;
  evaluatorLog: EvaluatorLog | null;
  artifactJson: ArtifactJson | null;
  /** Corrupt archive lines skipped by the reader (doctor's business). */
  corruptLines: number;
  /**
   * Non-tail corrupt lines. The rebuilt projections above folded ONLY
   * the survivors, so when this is non-zero they silently omit the lost
   * contributions — consumers serving STATE must treat the thread as
   * unreadable (the artifact-level contract); byte-level recovery
   * machinery (restore, repair) may still move the copy.
   */
  lossyLines: number;
}

export async function loadArtifactThreadFromArchive(
  projectDir: string,
  artifactId: string
): Promise<ArchivedArtifactThread> {
  const paths = archiveArtifactPaths(projectDir, artifactId);
  return loadArtifactThreadFromPaths(artifactId, paths.eventsNdjson, paths.sidecarsDir);
}

/**
 * Strictly reconstruct an artifact from an explicit event-log location.
 * Archive repair uses this against a staged replacement before it installs
 * that replacement over the precious archive copy.
 */
export async function loadArtifactThreadFromPaths(
  artifactId: string,
  eventsNdjson: string,
  sidecarsDir: string,
  containmentRoot?: string
): Promise<ArchivedArtifactThread> {
  const { events: records, corrupt } = await readEventLog({
    eventLogPath: eventsNdjson,
    sidecarsDir,
    containmentRoot,
  });
  const events = await loadEventsWithPayloads(records, { sidecarsDir, containmentRoot });
  assertArtifactIdentity(artifactId, events);
  return {
    artifactId,
    events,
    plan: rebuildPlanFromEvents(events)?.plan ?? null,
    checkpoints: rebuildAllCheckpointsFromEvents(events),
    summary: rebuildSummaryFromEvents(events)?.summary ?? null,
    evaluatorLog: rebuildEvaluatorLogFromEvents(events, artifactId)?.log ?? null,
    artifactJson: rebuildArtifactJsonFromEvents(events)?.json ?? null,
    corruptLines: corrupt.length,
    lossyLines: corrupt.filter((c) => c.kind !== 'truncated_tail').length,
  };
}

function assertArtifactIdentity(artifactId: string, events: readonly EventWithPayload[]): void {
  for (const event of events) {
    if (
      event.payload === null ||
      typeof event.payload !== 'object' ||
      Array.isArray(event.payload) ||
      !Object.prototype.hasOwnProperty.call(event.payload, 'artifact_id')
    ) {
      continue;
    }
    const payloadArtifactId = (event.payload as Record<string, unknown>).artifact_id;
    if (payloadArtifactId !== artifactId) {
      throw new Error(
        `Archive artifact ${JSON.stringify(artifactId)} contains a ${event.record.type} event for ${JSON.stringify(payloadArtifactId)}.`
      );
    }
  }
}

/** Archived artifact ids for a project = subdirectories of `artifacts/`. */
export async function listArchivedArtifactIds(projectDir: string): Promise<string[]> {
  try {
    const entries = await readdir(`${projectDir}/artifacts`, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

/** The project's mirrored usage-ledger events, payloads loaded. */
export async function readArchivedUsageEvents(
  projectDir: string,
  onInvalidRecord?: () => void
): Promise<LoadedUsageEvent[]> {
  const paths = archiveUsageLedgerPaths(projectDir);
  return readUsageLedger({
    ledgerPath: paths.ledgerNdjson,
    sidecarsDir: paths.sidecarsDir,
    onInvalidRecord,
  });
}
