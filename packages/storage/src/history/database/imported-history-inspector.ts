// Read-only inspectors for the history the converter retained but no live typed family can hold:
// the frozen 0.2.0-rc.2 source-plan pull cache, session-branch state and per-artifact cloud
// facts. They decode the retained content for inspection so it stays useful after the converter
// is removed, but they invent no owner: every result is marked unknown-account, none opens a
// writer, records an operation, replays anything or reconstructs an account. They take a
// `ProjectDatabase` handle and only read through it, so the caller supplies the read-only access.
import { assertProjectDatabasePath, type ProjectDatabase } from './connection.js';
import { ProjectDatabaseError } from './errors.js';

function integrity(): never {
  throw new ProjectDatabaseError(
    'HISTORY_INTEGRITY_REQUIRED',
    'Retained imported history carries unexpected ownership; preserve it for explicit repair'
  );
}

export interface ImportedSourcePlanRecordInspection {
  readonly sourceLocation: string;
  readonly kind: 'approved' | 'review' | 'locator';
  readonly namespaceBaseUrl: string;
  readonly namespaceOrgId: string;
  readonly externalId: string;
  readonly slug: string | null;
  readonly versionNumber: number | null;
  readonly versionId: string | null;
  readonly target: string | null;
  readonly title: string | null;
  readonly contentHash: string | null;
  readonly bodyHex: string | null;
  readonly realPath: string | null;
  readonly pulledAt: string | null;
  readonly recordHex: string;
  readonly recordSha256: string;
  readonly accountProvenance: 'unknown';
}

export interface ImportedSessionBranchInspection {
  readonly ordinal: number;
  readonly repoUrl: string;
  readonly workingDir: string;
  readonly currentBranch: string;
  readonly branchHistory: readonly string[];
  readonly baseCommitSha: string | null;
  readonly ackedAt: string | null;
  readonly updatedAt: string | null;
  readonly sourceLocation: string;
  readonly accountProvenance: 'unknown';
}

export interface ImportedCloudFactInspection {
  readonly artifactId: string;
  readonly syncedAt: string | null;
  readonly syncHash: string | null;
  readonly externalId: string | null;
  readonly orgId: string | null;
  readonly lastPushAttemptAt: string | null;
  readonly lastPushErrorKind: string | null;
  readonly lastPushErrorMessage: string | null;
  readonly consecutiveFailures: number | null;
  readonly sourceLocation: string;
  readonly accountProvenance: 'unknown';
}

function assertUnknown(rows: readonly { provenance: string }[]): void {
  if (rows.some((row) => row.provenance !== 'unknown')) integrity();
}

/**
 * Decode each retained imported source-plan record's content. The rows cannot be reached through
 * the account-scoped source-plan readers — `source_plan_records` requires an account namespace the
 * frozen pull cache never had — so this is how the retained content is inspected without inventing
 * that account.
 */
export function inspectImportedSourcePlanRecords(
  handle: ProjectDatabase
): readonly ImportedSourcePlanRecordInspection[] {
  assertProjectDatabasePath(handle);
  const rows = handle.read((view) =>
    view.all<{
      source_location: string;
      kind: 'approved' | 'review' | 'locator';
      namespace_base_url: string;
      namespace_org_id: string;
      external_id: string;
      slug: string | null;
      version_number: number | null;
      version_id: string | null;
      target: string | null;
      title: string | null;
      content_hash: string | null;
      body_hex: string | null;
      real_path: string | null;
      pulled_at: string | null;
      record_hex: string;
      record_sha256: string;
      provenance: string;
    }>(
      `SELECT source_location, kind, namespace_base_url, namespace_org_id, external_id, slug,
        version_number, version_id, target, title, content_hash, hex(body_bytes) AS body_hex,
        real_path, pulled_at, hex(record_bytes) AS record_hex, record_sha256,
        account_provenance AS provenance
       FROM legacy_source_plan_records ORDER BY source_location`
    )
  ).value;
  assertUnknown(rows);
  return Object.freeze(
    rows.map((row) =>
      Object.freeze({
        sourceLocation: row.source_location,
        kind: row.kind,
        namespaceBaseUrl: row.namespace_base_url,
        namespaceOrgId: row.namespace_org_id,
        externalId: row.external_id,
        slug: row.slug,
        versionNumber: row.version_number,
        versionId: row.version_id,
        target: row.target,
        title: row.title,
        contentHash: row.content_hash,
        bodyHex: row.body_hex,
        realPath: row.real_path,
        pulledAt: row.pulled_at,
        recordHex: row.record_hex,
        recordSha256: row.record_sha256,
        accountProvenance: 'unknown' as const,
      })
    )
  );
}

/** Decode each retained imported session-branch record's content, ownership left unknown. */
export function inspectImportedSessionBranches(
  handle: ProjectDatabase
): readonly ImportedSessionBranchInspection[] {
  assertProjectDatabasePath(handle);
  const rows = handle.read((view) =>
    view.all<{
      ordinal: number;
      repo_url: string;
      working_dir: string;
      current_branch: string;
      branch_history_json: string;
      base_commit_sha: string | null;
      acked_at: string | null;
      updated_at: string | null;
      source_location: string;
      provenance: string;
    }>(
      `SELECT ordinal, repo_url, working_dir, current_branch, branch_history_json,
        base_commit_sha, acked_at, updated_at, source_location, account_provenance AS provenance
       FROM legacy_session_branch_state ORDER BY ordinal`
    )
  ).value;
  assertUnknown(rows);
  return Object.freeze(
    rows.map((row) => {
      const branchHistory = JSON.parse(row.branch_history_json) as unknown;
      if (!Array.isArray(branchHistory) || branchHistory.some((b) => typeof b !== 'string'))
        integrity();
      return Object.freeze({
        ordinal: row.ordinal,
        repoUrl: row.repo_url,
        workingDir: row.working_dir,
        currentBranch: row.current_branch,
        branchHistory: Object.freeze(branchHistory as string[]),
        baseCommitSha: row.base_commit_sha,
        ackedAt: row.acked_at,
        updatedAt: row.updated_at,
        sourceLocation: row.source_location,
        accountProvenance: 'unknown' as const,
      });
    })
  );
}

/** Decode each retained imported per-artifact cloud fact's content, ownership left unknown. */
export function inspectImportedCloudFacts(
  handle: ProjectDatabase
): readonly ImportedCloudFactInspection[] {
  assertProjectDatabasePath(handle);
  const rows = handle.read((view) =>
    view.all<{
      artifact_id: string;
      synced_at: string | null;
      sync_hash: string | null;
      external_id: string | null;
      org_id: string | null;
      last_push_attempt_at: string | null;
      last_push_error_kind: string | null;
      last_push_error_message: string | null;
      consecutive_failures: number | null;
      source_location: string;
      provenance: string;
    }>(
      `SELECT artifact_id, synced_at, sync_hash, external_id, org_id, last_push_attempt_at,
        last_push_error_kind, last_push_error_message, consecutive_failures, source_location,
        account_provenance AS provenance
       FROM legacy_artifact_cloud_facts ORDER BY artifact_id`
    )
  ).value;
  assertUnknown(rows);
  return Object.freeze(
    rows.map((row) =>
      Object.freeze({
        artifactId: row.artifact_id,
        syncedAt: row.synced_at,
        syncHash: row.sync_hash,
        externalId: row.external_id,
        orgId: row.org_id,
        lastPushAttemptAt: row.last_push_attempt_at,
        lastPushErrorKind: row.last_push_error_kind,
        lastPushErrorMessage: row.last_push_error_message,
        consecutiveFailures: row.consecutive_failures,
        sourceLocation: row.source_location,
        accountProvenance: 'unknown' as const,
      })
    )
  );
}
