import { decodeArtifactInput } from './artifact-events.js';
import { digest } from '../event-integrity.js';
import type { ArtifactRevision } from './artifacts.js';
import type { ProjectDatabase, ProjectReadView } from './connection.js';
import { ProjectDatabaseError } from './errors.js';
import { assertCapturePublicationEvent } from './retention-event.js';
import type { GitRetentionPreparation } from './retention-input.js';
import type { ProjectSettlement } from './transactions.js';
import { canonicalJson } from '../../events/canonical-json.js';

export function staleRetention(): never {
  throw new ProjectDatabaseError(
    'STALE_CONTEXT',
    'Original Git publication target or state changed; prepare an explicitly new operation without retargeting this identity'
  );
}
export function assertRetentionTarget(view: ProjectReadView, input: GitRetentionPreparation): void {
  const target = input.target;
  if (target.kind === 'capture') {
    const revision = view.get(
      'SELECT r.generation, r.ordered_hash AS orderedHash, r.event_count AS eventCount, r.byte_length AS byteLength, r.tail_event_id AS tailEventId FROM artifacts a JOIN artifact_revisions r ON r.artifact_id = a.artifact_id AND r.generation = a.current_generation WHERE a.artifact_id = ?',
      target.artifactId
    );
    if (canonicalJson(revision) !== canonicalJson(target.expectedRevision)) staleRetention();
    const execution = view.get(
      'SELECT version, binding_generation AS generation FROM execution_current WHERE artifact_id = ?',
      target.artifactId
    );
    const expected =
      target.expectedExecutionVersion === null
        ? null
        : {
            version: target.expectedExecutionVersion,
            generation: target.expectedBindingGeneration,
          };
    if (canonicalJson(execution) !== canonicalJson(expected)) staleRetention();
    if (input.publications.some((publication) => publication.role === 'baseline')) {
      const current = view.get<{ publicationId: string }>(
        'SELECT publication_id AS publicationId FROM artifact_baseline_current WHERE artifact_id = ?',
        target.artifactId
      );
      if ((current?.publicationId ?? null) !== target.expectedBaselinePublicationId)
        staleRetention();
    }
  } else {
    const selection = view.get(
      'SELECT s.membership_revision_id AS membershipRevisionId, s.base_revision_id AS baseRevisionId, s.floor_publication_id AS floorPublicationId, s.current_run_id AS runId, r.current_revision_id AS runRevisionId, s.membership_version AS membershipVersion, s.base_version AS baseVersion, s.floor_version AS floorVersion, s.run_selection_version AS runSelectionVersion FROM review_selections s LEFT JOIN review_runs r ON r.review_id = s.review_id AND r.run_id = s.current_run_id WHERE s.review_id = ?',
      target.reviewId
    );
    const { kind: _kind, reviewId: _reviewId, ...expected } = target;
    if (canonicalJson(selection) !== canonicalJson(expected)) staleRetention();
  }
}
export function assertRetainedPublicationTargets(
  view: ProjectReadView,
  input: GitRetentionPreparation
): void {
  const target = input.target;
  if (target.kind === 'capture' && !target.expectedRevision)
    throw new ProjectDatabaseError(
      'INVALID_INPUT',
      'New capture input requires the fixed pending-capture aggregate, not retention-only admission'
    );
  for (const publication of input.publications) {
    const found =
      target.kind === 'capture'
        ? view.get(
            'SELECT event_id FROM artifact_events WHERE artifact_id = ? AND event_id = ? AND ordinal <= ?',
            target.artifactId,
            publication.targetId,
            target.expectedRevision!.eventCount
          )
        : publication.role === 'review-floor'
          ? view.get(
              "SELECT publication_id FROM review_evidence_publications WHERE review_id = ? AND publication_id = ? AND kind = 'floor'",
              target.reviewId,
              publication.targetId
            )
          : view.get(
              'SELECT revision_id FROM review_base_revisions WHERE review_id = ? AND revision_id = ?',
              target.reviewId,
              publication.targetId
            );
    if (!found)
      throw new ProjectDatabaseError(
        'INVALID_INPUT',
        'Retention-only publication requires an exact already-retained event, floor evidence or base revision; use the fixed domain aggregate for new input'
      );
  }
}
export function bindRetainedPublications(
  tx: ProjectSettlement,
  input: GitRetentionPreparation,
  committedCaptureRevision?: ArtifactRevision
): void {
  const target = input.target;
  for (const publication of input.publications) {
    if (target.kind === 'capture') {
      tx.run(
        'INSERT INTO artifact_retention_selections VALUES (?, ?, ?, ?, ?, ?)',
        publication.publicationId,
        input.operationId,
        target.artifactId,
        (committedCaptureRevision ?? target.expectedRevision)!.generation,
        publication.targetId,
        publication.role
      );
      if (publication.role === 'baseline') {
        if (target.expectedBaselinePublicationId === null)
          tx.run(
            "INSERT INTO artifact_baseline_current VALUES (?, ?, 'baseline')",
            target.artifactId,
            publication.publicationId
          );
        else
          tx.run(
            'UPDATE artifact_baseline_current SET publication_id = ? WHERE artifact_id = ?',
            publication.publicationId,
            target.artifactId
          );
      }
    } else
      tx.run(
        'INSERT INTO review_retention_bindings VALUES (?, ?, ?, ?, ?, ?, ?)',
        publication.publicationId,
        input.operationId,
        target.reviewId,
        publication.role,
        publication.targetId,
        publication.role === 'review-floor' ? publication.targetId : null,
        publication.role === 'review-base' ? publication.targetId : null
      );
  }
}

export function prepareRetainedPublicationInputs(
  handle: ProjectDatabase,
  input: GitRetentionPreparation,
  receiptId: string
): void {
  const target = input.target;
  if (target.kind !== 'capture') return;
  const observed = handle.read((view) => {
    if (view.get('SELECT operation_id FROM operations WHERE operation_id = ?', receiptId))
      return null;
    return input.publications.map((publication) => ({
      publication,
      row: view.get<{ bytes: string; sidecar: string | null; hash: string; type: string }>(
        'SELECT hex(record_bytes) AS bytes, CASE WHEN sidecar_payload_bytes IS NULL THEN NULL ELSE hex(sidecar_payload_bytes) END AS sidecar, record_hash AS hash, event_type AS type FROM artifact_events WHERE artifact_id = ? AND event_id = ?',
        target.artifactId,
        publication.targetId
      ),
    }));
  }).value;
  if (observed === null) return;
  for (const { publication, row } of observed) {
    if (!row)
      throw new ProjectDatabaseError(
        'INVALID_INPUT',
        'Capture retention-only publication needs its exact already-retained event'
      );
    let decoded: ReturnType<typeof decodeArtifactInput>;
    try {
      const bytes = Buffer.from(row.bytes, 'hex');
      if (digest(bytes) !== row.hash) throw new Error('Retained event hash differs');
      decoded = decodeArtifactInput(
        bytes,
        row.sidecar === null
          ? []
          : [{ eventId: publication.targetId, bytes: Buffer.from(row.sidecar, 'hex') }],
        [],
        false
      );
      if (
        decoded.length !== 1 ||
        decoded[0]!.event.record.event_id !== publication.targetId ||
        decoded[0]!.event.record.type !== row.type
      )
        throw new Error('Retained event identity differs');
    } catch (cause) {
      throw new ProjectDatabaseError(
        'HISTORY_INTEGRITY_REQUIRED',
        'Retained capture input is inconsistent; preserve history for explicit repair',
        { cause }
      );
    }
    assertCapturePublicationEvent(target.artifactId, publication, decoded[0]!.event);
  }
}
