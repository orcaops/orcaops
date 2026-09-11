import { isDeepStrictEqual } from 'node:util';

import type { ProjectCounters, ProjectDatabase, ProjectReadView } from './connection.js';
import { ProjectDatabaseError } from './errors.js';
import {
  copySeedBundleIdentity,
  type PreparedProjectSeedBundle,
  prepareImportedProjectSeedBundle,
  type SeedBundleIdentity,
  seedBundleKey,
  type SeedBundlePreparation,
  seedBundlePreparation,
  type SeedBundleSource,
  type SeedBundleView,
} from './seed-bundle-input.js';
import { copySeedRevision, type SeedRevision } from './seed-preparation.js';
import {
  type ProjectOperationOptions,
  type ProjectOperationResult,
  type ProjectSettlement,
  runProjectOperation,
} from './transactions.js';
import { canonicalJson } from '../../events/canonical-json.js';

const revisionColumns = 'revision_id AS revisionId, generation, content_hash AS contentHash';
const sourceColumns = `s.source_id AS sourceId, s.bundle_key AS bundleKey, s.key,
  s.source_identity AS sourceIdentity, s.source_location AS sourceLocation,
  s.source_revision_id AS sourceRevisionId, s.source_operation_id AS sourceOperationId,
  s.source_sha256 AS sourceSha256, hex(s.record_bytes) AS bytesHex, s.record_hash AS recordHash`;
function integrity(message: string, cause?: unknown): never {
  throw new ProjectDatabaseError('HISTORY_INTEGRITY_REQUIRED', message, { cause });
}
function currentRevision(view: ProjectReadView, key: string): SeedRevision | null {
  const revision = view.get<SeedRevision>(
    `SELECT ${revisionColumns} FROM seed_bundle_revisions WHERE bundle_key=? AND revision_id=(SELECT revision_id FROM seed_bundle_selection WHERE bundle_key=?)`,
    key,
    key
  );
  if (
    !revision &&
    (view.get('SELECT revision_id FROM seed_bundle_selection WHERE bundle_key=?', key) ||
      view.get('SELECT revision_id FROM seed_bundle_revisions WHERE bundle_key=? LIMIT 1', key) ||
      view.get('SELECT source_id FROM seed_bundle_sources WHERE bundle_key=? LIMIT 1', key))
  )
    integrity(
      'Seed bundle selection is missing while original history remains; preserve it for explicit repair'
    );
  return revision ?? null;
}
interface SourceRow {
  sourceId: string;
  bundleKey: string;
  key: string;
  sourceIdentity: string;
  sourceLocation: string;
  sourceRevisionId: string | null;
  sourceOperationId: string | null;
  sourceSha256: string | null;
  bytesHex: string;
  recordHash: string;
}
export interface ProjectSeedBundleSnapshot extends SeedBundleView {
  identity: SeedBundleIdentity;
  revision: SeedRevision;
  sources: SeedBundleSource[];
  counters: ProjectCounters;
}
export function readProjectSeedBundle(
  handle: ProjectDatabase,
  input: SeedBundleIdentity,
  selectedRevision?: SeedRevision
): ProjectSeedBundleSnapshot | null {
  const identity = copySeedBundleIdentity(input);
  const key = seedBundleKey(identity);
  const expected = selectedRevision === undefined ? undefined : copySeedRevision(selectedRevision);
  const read = handle.read((view) => {
    const revision =
      expected === undefined
        ? currentRevision(view, key)
        : view.get<SeedRevision>(
            `SELECT ${revisionColumns} FROM seed_bundle_revisions WHERE bundle_key=? AND revision_id=?`,
            key,
            expected.revisionId
          );
    if (!revision) {
      if (expected !== undefined)
        throw new ProjectDatabaseError(
          'HISTORY_MISSING',
          'The requested seed bundle revision is missing under its original identity; preserve history for explicit repair'
        );
      return null;
    }
    if (expected !== undefined && !isDeepStrictEqual(revision, expected))
      integrity('Seed bundle differs from the requested exact revision');
    const header = view.get<{ operationId: string }>(
      'SELECT operation_id AS operationId FROM seed_bundle_revisions WHERE revision_id=?',
      revision.revisionId
    )!;
    const sources = view.all<SourceRow>(
      `SELECT ${sourceColumns} FROM seed_bundle_members m JOIN seed_bundle_sources s ON s.source_id=m.source_id AND s.bundle_key=m.bundle_key WHERE m.revision_id=? AND m.bundle_key=? ORDER BY m.ordinal`,
      revision.revisionId,
      key
    );
    return { revision, header, sources };
  });
  if (!read.value) return null;
  const { revision, header, sources: retained } = read.value;
  try {
    const sources = retained.map(
      (source): SeedBundleSource => ({
        sourceId: source.sourceId,
        key: source.key,
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
    const prepared = seedBundlePreparation(
      prepareImportedProjectSeedBundle({
        operationId: header.operationId,
        revisionId: revision.revisionId,
        expectedRevision: null,
        sourceManifestIdentity: 'retained-database-seed',
        identity,
        sources,
      }),
      'historical'
    );
    if (
      prepared.contentHash !== revision.contentHash ||
      prepared.sources.some((source, index) => source.recordHash !== retained[index]!.recordHash)
    )
      integrity('Seed bundle bytes or membership differ from the exact retained revision');
    return { ...prepared.view, identity, revision, sources, counters: read.counters };
  } catch (cause) {
    integrity(
      'Retained seed bundle cannot be reconstructed exactly; preserve it for explicit repair',
      cause
    );
  }
}
function assertLookups(view: ProjectReadView, revision: SeedRevision): void {
  const expected = view.get<{ entries: number; authoring: number }>(
    'SELECT entry_count AS entries, authoring_count AS authoring FROM seed_bundle_details WHERE revision_id=?',
    revision.revisionId
  );
  if (!expected)
    integrity('Seed bundle lookup details are missing; explicitly rebuild from retained sources');
  const actual = view.get<{ entries: number; authoring: number }>(
    `SELECT (SELECT count(*) FROM seed_bundle_entries WHERE revision_id=?) AS entries, (SELECT count(*) FROM seed_bundle_authoring WHERE revision_id=?) AS authoring`,
    revision.revisionId,
    revision.revisionId
  )!;
  if (!isDeepStrictEqual(actual, expected))
    integrity(
      'Seed bundle lookup membership is incomplete; explicitly rebuild from retained sources'
    );
}
function prepareSources(prepared: SeedBundlePreparation) {
  return prepared.sources.map((source) => {
    const bytes = Buffer.from(source.bytes, 'base64');
    const expected: SourceRow = {
      sourceId: source.sourceId,
      bundleKey: prepared.bundleKey,
      key: source.key,
      sourceIdentity: source.sourceIdentity,
      sourceLocation: source.sourceLocation,
      sourceRevisionId: source.sourceRevisionId,
      sourceOperationId: source.sourceOperationId,
      sourceSha256: source.sourceSha256,
      bytesHex: bytes.toString('hex').toUpperCase(),
      recordHash: source.recordHash,
    };
    return { source, bytes, expected };
  });
}
function insertSources(
  transaction: ProjectSettlement,
  incoming: ReturnType<typeof prepareSources>
): void {
  for (const { source, bytes, expected } of incoming) {
    const prior = transaction.get<SourceRow>(
      `SELECT ${sourceColumns} FROM seed_bundle_sources s WHERE source_id=?`,
      source.sourceId
    );
    if (prior) {
      if (!isDeepStrictEqual(prior, expected))
        throw new ProjectDatabaseError(
          'IDEMPOTENCY_CONFLICT',
          'A retained seed bundle occurrence cannot carry changed bytes, provenance or target'
        );
      continue;
    }
    if (
      transaction.get('SELECT source_id FROM seed_state_sources WHERE source_id=?', source.sourceId)
    )
      throw new ProjectDatabaseError(
        'IDEMPOTENCY_CONFLICT',
        'This source occurrence belongs to seed state; preserve its original target'
      );
    transaction.run(
      'INSERT INTO seed_bundle_sources VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      source.sourceId,
      expected.bundleKey,
      source.key,
      source.sourceIdentity,
      source.sourceLocation,
      source.sourceRevisionId,
      source.sourceOperationId,
      source.sourceSha256,
      bytes,
      source.recordHash
    );
  }
}
function prepareLookups(prepared: SeedBundlePreparation) {
  const rows: Array<{ sql: string; values: unknown[] }> = [];
  const record = (sql: string, ...values: unknown[]) => rows.push({ sql, values });
  const { manifest, enrichment, authored, completeness } = prepared.view;
  const revision = prepared.revisionId;
  const amendment = manifest?.amendment;
  record(
    'INSERT INTO seed_bundle_details VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    revision,
    manifest?.options_hash ?? enrichment?.options_hash ?? null,
    amendment?.prior_enrichment_event_id ?? null,
    amendment?.member_shas_hash ?? null,
    amendment?.decision_mode ?? null,
    amendment === undefined ? null : Number(amendment.pr_context_consented),
    enrichment?.enriched_at ?? null,
    Number(completeness.complete),
    canonicalJson(completeness.issues),
    manifest?.bundles.length ?? 0,
    authored.length
  );
  for (const [index, entry] of (manifest?.bundles ?? []).entries())
    record(
      'INSERT INTO seed_bundle_entries VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      revision,
      index,
      entry.filename,
      entry.artifact_id,
      entry.cluster_key,
      entry.kind,
      entry.label,
      entry.date,
      entry.commit_count,
      entry.checkpoint_count,
      canonicalJson(entry.warnings),
      entry.nomination_count,
      entry.distinct_task_count
    );
  for (const item of authored)
    record(
      'INSERT INTO seed_bundle_authoring VALUES (?, ?, ?, ?, ?, ?, ?)',
      revision,
      item.sourceId,
      item.filename,
      item.enrichment.cluster_key,
      item.enrichment.options_hash,
      item.selection,
      canonicalJson(item.reasons)
    );
  return rows;
}
export interface SeedBundlePublicationResult {
  revision: SeedRevision;
  sourceIds: string[];
}
export async function publishProjectSeedBundle(
  handle: ProjectDatabase,
  input: PreparedProjectSeedBundle,
  options: ProjectOperationOptions = {}
): Promise<ProjectOperationResult<SeedBundlePublicationResult>> {
  const prepared = seedBundlePreparation(input, 'authored');
  const expected = prepared.expectedRevision;
  const revision = copySeedRevision({
    revisionId: prepared.revisionId,
    generation: (expected?.generation ?? 0) + 1,
    contentHash: prepared.contentHash,
  });
  const sources = prepareSources(prepared);
  const lookups = prepareLookups(prepared);
  return runProjectOperation(
    handle,
    {
      operationId: prepared.operationId,
      kind: 'seed.bundle',
      target: { projectId: handle.authority.projectId, bundleKey: prepared.bundleKey },
      payload: { revisionId: revision.revisionId, contentHash: revision.contentHash },
      expectedState: expected === null ? null : { ...expected },
      intentChange: false,
    },
    (transaction) => {
      const current = currentRevision(transaction, prepared.bundleKey);
      if (current) assertLookups(transaction, current);
      if (!isDeepStrictEqual(current, expected))
        throw new ProjectDatabaseError(
          'STALE_CONTEXT',
          'Seed bundle changed after preparation; prepare an explicitly new operation against the intended revision'
        );
      if (
        transaction.get(
          'SELECT revision_id FROM seed_bundle_revisions WHERE revision_id=?',
          revision.revisionId
        ) ||
        transaction.get(
          'SELECT revision_id FROM seed_state_revisions WHERE revision_id=?',
          revision.revisionId
        )
      )
        throw new ProjectDatabaseError(
          'IDEMPOTENCY_CONFLICT',
          'This seed revision identity is already retained; preserve its original target'
        );
      insertSources(transaction, sources);
      transaction.run(
        'INSERT INTO seed_bundle_revisions VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        revision.revisionId,
        prepared.bundleKey,
        prepared.identity.kind,
        prepared.identity.kind === 'pending' ? null : prepared.identity.artifactId,
        revision.generation,
        prepared.operationId,
        expected?.revisionId ?? null,
        revision.contentHash
      );
      prepared.sources.forEach((source, index) =>
        transaction.run(
          'INSERT INTO seed_bundle_members VALUES (?, ?, ?, ?)',
          revision.revisionId,
          prepared.bundleKey,
          index,
          source.sourceId
        )
      );
      for (const row of lookups) transaction.run(row.sql, ...row.values);
      if (expected === null)
        transaction.run(
          'INSERT INTO seed_bundle_selection VALUES (?, ?)',
          prepared.bundleKey,
          revision.revisionId
        );
      else
        transaction.run(
          'UPDATE seed_bundle_selection SET revision_id=? WHERE bundle_key=?',
          revision.revisionId,
          prepared.bundleKey
        );
      return {
        revision: { ...revision },
        sourceIds: prepared.sources.map((source) => source.sourceId),
      };
    },
    options
  );
}
