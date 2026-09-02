/**
 * Thrown by the cloud sync layer when the user has not run `orcaops login`
 * (no credentials file). Callers should map this to a user-facing message
 * pointing at `orcaops login` rather than a stack trace.
 */
export class NotConnectedError extends Error {
  readonly name = 'NotConnectedError';
  constructor(message = 'Not connected. Run `orcaops login` first.') {
    super(message);
  }
}

/**
 * Thrown when `orcaops push` is invoked against an artifact_id that doesn't
 * exist on disk. Distinguished from cloud-side errors so callers can render
 * "no such artifact" rather than "cloud error."
 */
export class ArtifactNotFoundError extends Error {
  readonly name = 'ArtifactNotFoundError';
  constructor(artifactId: string) {
    super(`No artifact found locally with id "${artifactId}".`);
  }
}

/**
 * Thrown when a push needs the git remote but `git config remote.origin.url`
 * is empty. The cloud's repo model is keyed on remote URL — without it we
 * can't `repo.upsertByRemote`.
 */
export class MissingGitRemoteError extends Error {
  readonly name = 'MissingGitRemoteError';
  constructor() {
    super(
      'No `origin` remote is configured. The cloud needs a remote URL to identify the repo.\n' +
        'Run: git remote add origin <url>'
    );
  }
}

/**
 * Thrown by `pushArtifact` when the resolved git remote URL exceeds the
 * cloud's wire contract limit (2048 chars on `OssCaptureThreadStartPayload.
 * repo_url`). Without this local guard, the push surfaces as an opaque
 * cloud-side 400 with no clear remediation hint. Long GitHub Enterprise
 * vanity URLs and SSH config aliases with deep path segments occasionally
 * trip this.
 */
export class RepoUrlTooLongError extends Error {
  readonly name = 'RepoUrlTooLongError';
  constructor(actual: number, max: number) {
    super(
      `Git remote URL is ${actual} chars; the cloud's wire contract caps repo_url at ${max} chars.\n` +
        'Use a shorter alias (e.g. configure SSH alias in ~/.ssh/config) and retry.'
    );
  }
}

/**
 * Thrown by `pushArtifact` when a closed checkpoint's projection declares a
 * non-null `diff_fingerprint_summary.manifest_hash` but the full manifest
 * cannot be loaded from the event log (corrupt-dropped close event, missing
 * sidecar, etc.). Strict-sync: sync MUST present the
 * manifest the projection promises, or fail the push outright — never
 * silently sync without it (that would let auto-prune destroy the only
 * refs that could re-derive it). This is a HARD, artifact-attributable
 * failure: unlike the env-class errors above it is deliberately NOT added
 * to the eager-push skip list in cloud-sync.ts, so it gets recorded and
 * doctor's `cloud-sync-pending` surfaces it for `orcaops resync --force`
 * after the underlying disk/permissions issue is fixed.
 */
export class FingerprintManifestMissingError extends Error {
  readonly name = 'FingerprintManifestMissingError';
  constructor(artifactId: string, n: number) {
    super(
      `Checkpoint ${n} of artifact "${artifactId}" declares a diff-fingerprint ` +
        `manifest_hash but its manifest could not be loaded (corrupt or missing ` +
        `close-event payload). Sync refuses to proceed without it. Fix the ` +
        `underlying disk/permissions issue, then run \`orcaops resync --force\`.`
    );
  }
}

/**
 * Thrown by `pushArtifact` when the target artifact was imported from git
 * history (`origin_kind = 'git-import'`). Imported artifacts are local-only
 * in v1: the shared pending predicate already keeps them out of every drain
 * enumeration, and this guard closes the explicit-id path — thrown BEFORE any
 * cloud client is constructed, so a refused push never touches the network.
 */
export class ImportedArtifactLocalOnlyError extends Error {
  readonly name = 'ImportedArtifactLocalOnlyError';
  constructor(artifactId: string) {
    super(
      `Artifact "${artifactId}" was imported from git history: imported artifacts are ` +
        'local-only in this version; cloud upload for imported history arrives with ' +
        '`seed --push` in a future release.'
    );
  }
}

/**
 * The pinned source plan's stored `content` no longer hashes to its recorded
 * `hash`. The storage schema only requires a non-empty hash, so the
 * push re-verifies on materialize — a pin is a graded conformance anchor and
 * must never ship a body that drifted from its hash.
 */
export class SourcePlanIntegrityError extends Error {
  readonly name = 'SourcePlanIntegrityError';
  constructor(artifactId: string, expected: string, actual: string) {
    super(
      `Source plan pinned on artifact "${artifactId}" failed its integrity check: ` +
        `sha256(content)=${actual} != recorded hash=${expected}. The pinned plan body ` +
        `drifted from its hash; re-capture with a fresh \`--source-plan\`.`
    );
  }
}

/**
 * Why a done-criterion's open-time `text` could not be resolved. Each value
 * maps to a distinct disposition (transient → retry, invariant break →
 * report), so the failure self-diagnoses instead of hiding behind a generic
 * message.
 */
export type DoneCriterionTextUnresolvableKind =
  | 'open-revision-not-in-cache'
  | 'criterion-absent-in-open-revision';

const DONE_CRITERION_REMEDIATION: Record<DoneCriterionTextUnresolvableKind, string> = {
  'open-revision-not-in-cache':
    'The open-time plan revision is missing from the local projection — run `orcaops rebuild` and retry the push.',
  'criterion-absent-in-open-revision':
    'The open-time revision resolved but does not contain this criterion — an invariant break (close-time validation should have rejected it). Report this.',
};

/**
 * Thrown by the cloud-sync `done_criteria` producer when a closed checkpoint's
 * done-criterion `text` cannot be resolved from the plan revision the
 * checkpoint opened against. The V4 wire requires a non-blank `text` on every
 * done-criterion (the cloud snapshots the open-time rubric verbatim), so a
 * degraded read must NOT be shipped — sync fails fast and the `kind` names the
 * disposition (see `DoneCriterionTextUnresolvableKind`). Like
 * `FingerprintManifestMissingError`, this is a HARD, artifact-attributable
 * failure: it never fires when close-time validation recorded the open-time
 * revision, so it isn't an availability risk — but when it does fire it is
 * recorded for follow-up rather than silently dropped.
 */
export class DoneCriterionTextUnresolvableError extends Error {
  readonly name = 'DoneCriterionTextUnresolvableError';
  constructor(
    readonly artifactId: string,
    readonly n: number,
    readonly criterionId: string | null,
    readonly kind: DoneCriterionTextUnresolvableKind
  ) {
    super(
      `Checkpoint ${n} of artifact "${artifactId}": cannot resolve the open-time text for ` +
        `done-criterion ${criterionId === null ? '(unknown)' : `"${criterionId}"`} (${kind}). ` +
        `The V4 wire requires the open-time criterion text; sync refuses to ship a degraded ` +
        `read. ${DONE_CRITERION_REMEDIATION[kind]}`
    );
  }
}
