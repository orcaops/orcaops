import { isDeepStrictEqual } from 'node:util';

import { canonicalJson } from '../../events/canonical-json.js';
import { SeedJobRecordSchema, SeedJournalClusterSchema } from '../seed-schema.js';
import type { ProjectCounters, ProjectDatabase, ProjectReadView } from './connection.js';
import { ProjectDatabaseError } from './errors.js';
import { copySeedRevision, type SeedRevision } from './seed-preparation.js';
import {
  type PreparedImportedProjectSeedState,
  type PreparedProjectSeedState,
  prepareImportedProjectSeedState,
  type SeedStatePreparation,
  seedStatePreparation,
  type SeedStateSource,
  type SeedStateView,
} from './seed-state-input.js';
import {
  type ProjectOperation,
  type ProjectOperationOptions,
  type ProjectOperationResult,
  type ProjectSettlement,
  runProjectOperation,
} from './transactions.js';
import type { DatabaseJson } from './values.js';

const revisionColumns = 'revision_id AS revisionId, generation, content_hash AS contentHash';
const sourceColumns = `s.source_id AS sourceId, s.kind, s.source_identity AS sourceIdentity,
  s.source_location AS sourceLocation, s.source_revision_id AS sourceRevisionId,
  s.source_operation_id AS sourceOperationId, s.source_sha256 AS sourceSha256,
  hex(s.record_bytes) AS bytesHex, s.record_hash AS recordHash, s.schema_version AS schemaVersion`;
function integrity(message: string, cause?: unknown): never {
  throw new ProjectDatabaseError('HISTORY_INTEGRITY_REQUIRED', message, { cause });
}
function currentRevision(view: ProjectReadView): SeedRevision | null {
  const revision = view.get<SeedRevision>(
    `SELECT ${revisionColumns} FROM seed_state_revisions WHERE revision_id = (SELECT revision_id FROM seed_state_selection WHERE singleton = 1)`
  );
  if (
    !revision &&
    (view.get('SELECT singleton FROM seed_state_selection') ||
      view.get('SELECT revision_id FROM seed_state_revisions LIMIT 1') ||
      view.get('SELECT source_id FROM seed_state_sources LIMIT 1'))
  )
    integrity(
      'Seed selection is missing while original history remains; preserve it for explicit repair'
    );
  return revision ?? null;
}
function selectRevision(view: ProjectReadView, expected?: SeedRevision): SeedRevision | null {
  if (expected === undefined) return currentRevision(view);
  const revision = view.get<SeedRevision>(
    `SELECT ${revisionColumns} FROM seed_state_revisions WHERE revision_id = ?`,
    expected.revisionId
  );
  if (!revision)
    throw new ProjectDatabaseError(
      'HISTORY_MISSING',
      'The requested immutable seed revision is missing; preserve history for explicit repair'
    );
  if (!isDeepStrictEqual(revision, expected))
    integrity('Seed revision differs from its exact requested identity');
  return revision;
}
interface SourceRow {
  sourceId: string;
  kind: SeedStateSource['kind'];
  sourceIdentity: string;
  sourceLocation: string;
  sourceRevisionId: string | null;
  sourceOperationId: string | null;
  sourceSha256: string | null;
  bytesHex: string;
  recordHash: string;
  schemaVersion: number;
}
export interface ProjectSeedStateSnapshot extends SeedStateView {
  revision: SeedRevision;
  sources: SeedStateSource[];
  counters: ProjectCounters;
}
export function readProjectSeedState(
  handle: ProjectDatabase,
  selectedRevision?: SeedRevision
): ProjectSeedStateSnapshot | null {
  const expected = selectedRevision === undefined ? undefined : copySeedRevision(selectedRevision);
  const read = handle.read((view) => {
    const revision = selectRevision(view, expected);
    if (!revision) return null;
    const header = view.get<{
      operationId: string;
      precious: string | null;
      journal: string | null;
      coverage: string | null;
    }>(
      'SELECT operation_id AS operationId, precious_source_id AS precious, journal_source_id AS journal, coverage_source_id AS coverage FROM seed_state_revisions WHERE revision_id=?',
      revision.revisionId
    )!;
    const sources = view.all<SourceRow>(
      `SELECT ${sourceColumns} FROM seed_state_members m JOIN seed_state_sources s ON s.source_id=m.source_id WHERE m.revision_id=? ORDER BY m.ordinal`,
      revision.revisionId
    );
    return { revision, header, sources };
  });
  if (!read.value) return null;
  const { revision, header, sources: retained } = read.value;
  try {
    const sources = retained.map(
      (source): SeedStateSource => ({
        sourceId: source.sourceId,
        kind: source.kind,
        sourceIdentity: source.sourceIdentity,
        sourceLocation: source.sourceLocation,
        ...(source.sourceRevisionId === null ? {} : { sourceRevisionId: source.sourceRevisionId }),
        ...(source.sourceOperationId === null
          ? {}
          : { sourceOperationId: source.sourceOperationId }),
        ...(source.sourceSha256 === null ? {} : { sourceSha256: source.sourceSha256 }),
        bytes: Buffer.from(source.bytesHex, 'hex'),
      })
    );
    const prepared = seedStatePreparation(
      prepareImportedProjectSeedState({
        operationId: header.operationId,
        revisionId: revision.revisionId,
        expectedRevision: null,
        sourceManifestIdentity: 'retained-database-seed',
        sources,
      }),
      'historical'
    );
    if (
      prepared.contentHash !== revision.contentHash ||
      !isDeepStrictEqual(prepared.selected, {
        precious: header.precious,
        journal: header.journal,
        coverage: header.coverage,
      }) ||
      prepared.sources.some(
        (source, index) =>
          source.recordHash !== retained[index]!.recordHash ||
          source.schemaVersion !== retained[index]!.schemaVersion
      )
    )
      integrity(
        'Original seed bytes, membership or selected source differ from their retained revision'
      );
    return { ...prepared.view, revision, sources, counters: read.counters };
  } catch (cause) {
    integrity(
      'Retained seed state cannot be reconstructed exactly; preserve it for explicit repair',
      cause
    );
  }
}
interface SeedDetails {
  clusterCount: number;
  jobCount: number;
  discoveryCount: number;
}
function assertSeedLookups(view: ProjectReadView, revision: SeedRevision): void {
  const details = view.get<SeedDetails>(
    'SELECT cluster_count AS clusterCount, job_count AS jobCount, discovery_area_count AS discoveryCount FROM seed_state_details WHERE revision_id=?',
    revision.revisionId
  );
  if (!details)
    integrity('Seed lookup details are missing; explicitly rebuild from retained sources');
  const counts = view.get<SeedDetails>(
    `SELECT
    (SELECT count(*) FROM seed_clusters WHERE revision_id=?) AS clusterCount,
    (SELECT count(*) FROM seed_jobs WHERE revision_id=?) AS jobCount,
    (SELECT count(*) FROM seed_discovery_areas WHERE revision_id=?) AS discoveryCount`,
    revision.revisionId,
    revision.revisionId,
    revision.revisionId
  )!;
  if (!isDeepStrictEqual(details, counts))
    integrity('Seed lookup membership is incomplete; explicitly rebuild from retained sources');
}
export interface SeedLookupSelection {
  revision?: SeedRevision;
  key?: string;
}
function lookupSelection(input: SeedLookupSelection): SeedLookupSelection {
  const revision = input.revision === undefined ? undefined : copySeedRevision(input.revision);
  const key = input.key;
  if (key !== undefined && typeof key !== 'string')
    throw new ProjectDatabaseError('INVALID_INPUT', 'Select a seed lookup key as a string');
  return { revision, key };
}
export function readProjectSeedClusters(handle: ProjectDatabase, input: SeedLookupSelection = {}) {
  const selection = lookupSelection(input);
  const read = handle.read((view) => {
    const revision = selectRevision(view, selection.revision);
    if (!revision) return null;
    assertSeedLookups(view, revision);
    const rows = view.all<{
      key: string;
      artifactId: string;
      status: string;
      error: string | null;
    }>(
      `SELECT cluster_key AS key, artifact_id AS artifactId, status, error FROM seed_clusters WHERE revision_id=?${selection.key === undefined ? '' : ' AND cluster_key=?'} ORDER BY cluster_key`,
      revision.revisionId,
      ...(selection.key === undefined ? [] : [selection.key])
    );
    return { revision, rows };
  });
  if (!read.value) return null;
  try {
    return {
      revision: read.value.revision,
      clusters: Object.fromEntries(
        read.value.rows.map((row) => [
          row.key,
          SeedJournalClusterSchema.parse({
            artifact_id: row.artifactId,
            status: row.status,
            ...(row.error === null ? {} : { error: row.error }),
          }),
        ])
      ),
      counters: read.counters,
    };
  } catch (cause) {
    integrity('Seed cluster lookup is invalid; explicitly rebuild from retained sources', cause);
  }
}
export function readProjectSeedJobs(handle: ProjectDatabase, input: SeedLookupSelection = {}) {
  const selection = lookupSelection(input);
  const read = handle.read((view) => {
    const revision = selectRevision(view, selection.revision);
    if (!revision) return null;
    assertSeedLookups(view, revision);
    const rows = view.all<{
      key: string;
      kind: string;
      invokedBy: string | null;
      startedAt: string;
      finishedAt: string | null;
      wallTime: number | null;
      budget: string | null;
      skippedCovered: number | null;
      skips: string | null;
    }>(
      `SELECT job_id AS key, kind, invoked_by AS invokedBy, started_at AS startedAt, finished_at AS finishedAt, wall_time_ms AS wallTime, budget_json AS budget, skipped_covered AS skippedCovered, skips_json AS skips FROM seed_jobs WHERE revision_id=?${selection.key === undefined ? '' : ' AND job_id=?'} ORDER BY job_id`,
      revision.revisionId,
      ...(selection.key === undefined ? [] : [selection.key])
    );
    return { revision, rows };
  });
  if (!read.value) return null;
  try {
    return {
      revision: read.value.revision,
      jobs: Object.fromEntries(
        read.value.rows.map((row) => [
          row.key,
          SeedJobRecordSchema.parse({
            kind: row.kind,
            started_at: row.startedAt,
            ...(row.invokedBy === null ? {} : { invoked_by: row.invokedBy }),
            ...(row.finishedAt === null ? {} : { finished_at: row.finishedAt }),
            ...(row.wallTime === null ? {} : { wall_time_ms: row.wallTime }),
            ...(row.budget === null ? {} : { budget: JSON.parse(row.budget) }),
            ...(row.skippedCovered === null ? {} : { skipped_covered: row.skippedCovered }),
            ...(row.skips === null ? {} : { skips: JSON.parse(row.skips) }),
          }),
        ])
      ),
      counters: read.counters,
    };
  } catch (cause) {
    integrity('Seed job lookup is invalid; explicitly rebuild from retained sources', cause);
  }
}
function prepareSources(prepared: SeedStatePreparation) {
  return prepared.sources.map((source) => {
    const bytes = Buffer.from(source.bytes, 'base64');
    const expected: SourceRow = {
      sourceId: source.sourceId,
      kind: source.kind,
      sourceIdentity: source.sourceIdentity,
      sourceLocation: source.sourceLocation,
      sourceRevisionId: source.sourceRevisionId,
      sourceOperationId: source.sourceOperationId,
      sourceSha256: source.sourceSha256,
      bytesHex: bytes.toString('hex').toUpperCase(),
      recordHash: source.recordHash,
      schemaVersion: source.schemaVersion,
    };
    return { source, expected, bytes };
  });
}
function insertSources(
  transaction: ProjectSettlement,
  incoming: ReturnType<typeof prepareSources>
): void {
  for (const { source, expected, bytes } of incoming) {
    const prior = transaction.get<SourceRow>(
      `SELECT ${sourceColumns} FROM seed_state_sources s WHERE s.source_id=?`,
      source.sourceId
    );
    if (prior) {
      if (!isDeepStrictEqual(prior, expected))
        throw new ProjectDatabaseError(
          'IDEMPOTENCY_CONFLICT',
          'A retained seed source identity cannot carry changed bytes or provenance'
        );
      continue;
    }
    if (
      transaction.get(
        'SELECT source_id FROM seed_bundle_sources WHERE source_id=?',
        source.sourceId
      )
    )
      throw new ProjectDatabaseError(
        'IDEMPOTENCY_CONFLICT',
        'This seed occurrence already belongs to a bundle; retain its original target'
      );
    transaction.run(
      'INSERT INTO seed_state_sources VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      source.sourceId,
      source.kind,
      source.sourceIdentity,
      source.sourceLocation,
      source.sourceRevisionId,
      source.sourceOperationId,
      source.sourceSha256,
      bytes,
      source.recordHash,
      source.schemaVersion
    );
  }
}
function prepareLookups(prepared: SeedStatePreparation) {
  const rows: Array<{ sql: string; values: unknown[] }> = [];
  const record = (sql: string, ...values: unknown[]) => rows.push({ sql, values });
  const { precious, journal, completeness } = prepared.view;
  const revision = prepared.revisionId;
  const clusters = Object.entries(journal?.clusters ?? {});
  const jobs = Object.entries(journal?.jobs ?? {});
  const areas = Object.entries(precious?.discovery_areas ?? {});
  record(
    'INSERT INTO seed_state_details VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    revision,
    precious?.install_nonce ?? journal?.install_nonce ?? null,
    journal?.options_hash ?? null,
    precious?.updated_at ?? journal?.updated_at ?? null,
    precious === null ? null : Number(precious.pr_context),
    precious === null ? null : Number(precious.pending_importance),
    precious === null ? null : Number(precious.commit_graph_hint_shown),
    Number(completeness.complete),
    canonicalJson(completeness.issues),
    clusters.length,
    jobs.length,
    areas.length
  );
  for (const [key, cluster] of clusters)
    record(
      'INSERT INTO seed_clusters VALUES (?, ?, ?, ?, ?)',
      revision,
      key,
      cluster.artifact_id,
      cluster.status,
      cluster.error ?? null
    );
  for (const [key, job] of jobs)
    record(
      'INSERT INTO seed_jobs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      revision,
      key,
      job.kind,
      job.invoked_by ?? null,
      job.started_at,
      job.finished_at ?? null,
      job.wall_time_ms ?? null,
      job.budget === undefined ? null : canonicalJson(job.budget),
      job.skipped_covered ?? null,
      job.skips === undefined ? null : canonicalJson(job.skips)
    );
  for (const [area, value] of areas)
    record(
      'INSERT INTO seed_discovery_areas VALUES (?, ?, ?, ?, ?, ?)',
      revision,
      area,
      value.declined_at ?? null,
      Number(Object.hasOwn(value, 'declined_at')),
      value.offered_at ?? null,
      value.declined_paths === undefined ? null : canonicalJson(value.declined_paths)
    );
  return rows;
}
export interface SeedStatePublicationResult {
  revision: SeedRevision;
  sourceIds: string[];
}
export async function publishProjectSeedState(
  handle: ProjectDatabase,
  input: PreparedProjectSeedState,
  options: ProjectOperationOptions = {}
): Promise<ProjectOperationResult<SeedStatePublicationResult>> {
  const composed = prepareSeedStateSettlement(handle.authority.projectId, input, 'authored');
  return runProjectOperation<SeedStatePublicationResult & DatabaseJson>(
    handle,
    composed.operation,
    (transaction) => composed.settle(transaction) as SeedStatePublicationResult & DatabaseJson,
    options
  );
}

// Composed apart from the operation runner so a conversion can settle the identical rows for
// a target database whose connection does not exist yet.
export function prepareSeedStateSettlement(
  projectId: string,
  input: PreparedProjectSeedState | PreparedImportedProjectSeedState,
  mode: 'authored' | 'historical'
): {
  operation: ProjectOperation;
  settle: (transaction: ProjectSettlement) => SeedStatePublicationResult;
} {
  const prepared = seedStatePreparation(input, mode);
  const expected = prepared.expectedRevision;
  const revision = copySeedRevision({
    revisionId: prepared.revisionId,
    generation: (expected?.generation ?? 0) + 1,
    contentHash: prepared.contentHash,
  });
  const incoming = prepareSources(prepared);
  const lookups = prepareLookups(prepared);
  return {
    operation: {
      operationId: prepared.operationId,
      kind: 'seed.state',
      target: { projectId },
      payload: { revisionId: revision.revisionId, contentHash: revision.contentHash },
      expectedState: expected === null ? null : { ...expected },
      intentChange: false,
    },
    settle: (transaction: ProjectSettlement) => {
      const current = currentRevision(transaction);
      if (current) assertSeedLookups(transaction, current);
      if (!isDeepStrictEqual(current, expected))
        throw new ProjectDatabaseError(
          'STALE_CONTEXT',
          'Seed state advanced after preparation; prepare a new operation against the intended revision'
        );
      if (
        transaction.get(
          'SELECT revision_id FROM seed_state_revisions WHERE revision_id=?',
          revision.revisionId
        ) ||
        transaction.get(
          'SELECT revision_id FROM seed_bundle_revisions WHERE revision_id=?',
          revision.revisionId
        )
      )
        throw new ProjectDatabaseError(
          'IDEMPOTENCY_CONFLICT',
          'Seed revision identity is already retained; preserve its original target'
        );
      insertSources(transaction, incoming);
      transaction.run(
        'INSERT INTO seed_state_revisions VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        revision.revisionId,
        revision.generation,
        prepared.operationId,
        expected?.revisionId ?? null,
        prepared.selected.precious,
        prepared.selected.journal,
        prepared.selected.coverage,
        prepared.contentHash
      );
      prepared.sources.forEach((source, index) =>
        transaction.run(
          'INSERT INTO seed_state_members VALUES (?, ?, ?)',
          revision.revisionId,
          index,
          source.sourceId
        )
      );
      for (const row of lookups) transaction.run(row.sql, ...row.values);
      if (expected === null)
        transaction.run('INSERT INTO seed_state_selection VALUES (1, ?)', revision.revisionId);
      else
        transaction.run(
          'UPDATE seed_state_selection SET revision_id=? WHERE singleton=1',
          revision.revisionId
        );
      return {
        revision: { ...revision },
        sourceIds: prepared.sources.map((source) => source.sourceId),
      };
    },
  };
}
