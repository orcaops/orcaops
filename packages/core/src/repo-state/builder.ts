import type { ArtifactThread } from '@orcaops/storage';

import type { Repo } from '../git/repo.js';

/**
 * Repo-state context block surfaced by `resume` and `show`.
 *
 * Answers two questions for a returning agent:
 *   1. "Has the world changed since the artifact last saw it?"
 *      (current_branch / head_sha vs artifact_head_sha + commits in
 *      between + dirty working tree).
 *   2. "Are any of the artifact's open items already addressed?"
 *      (heuristic — surface evidence, never auto-close).
 */

export interface RepoStateCommit {
  sha: string;
  subject: string;
  files: string[];
}

/**
 * Evidence that an open_item may have been addressed since the
 * artifact's last recorded head. Two kinds today:
 *   - `file_changed`: a commit since artifact_head_sha modified files
 *     in the artifact's `files_changed` set.
 *   - `later_artifact`: a later artifact on this branch declared the
 *     same files in its checkpoints.
 *
 * The heuristic intentionally doesn't disambiguate which open_item
 * the evidence supports (the spec applies it artifact-wide). Surface
 * as evidence; the user / agent decides whether the item is closed.
 */
export interface OpenItemEvidence {
  item: string;
  evidence:
    | { kind: 'file_changed'; files: string[] }
    | { kind: 'later_artifact'; artifact_id: string; files: string[] };
}

export interface RepoState {
  current_branch: string;
  current_head_sha: string;
  /** Latest head the artifact saw: summary > last cp > plan.base_sha. */
  artifact_head_sha: string | null;
  head_matches_artifact: boolean;
  working_tree_dirty: boolean;
  /** `git status --porcelain` output, truncated to the configured cap. */
  working_tree_status: string;
  /**
   * Commits between artifact_head_sha and current HEAD that touch any
   * file in the artifact's `files_changed` union (across checkpoints).
   * Empty when the head matches the artifact, when the artifact has no
   * recorded files, or when no in-range commits intersect.
   */
  commits_since_artifact_head_touching_artifact_files: RepoStateCommit[];
  open_items_addressed_since: OpenItemEvidence[];
}

export interface RepoStateSnapshotOptions {
  repo: Repo;
  artifactId: string;
  snapshot: Pick<ArtifactThread, 'plan' | 'checkpoints' | 'summary'>;
  laterArtifactEvidence: { artifact_id: string; files: string[] } | null;
  /**
   * Cap `working_tree_status` at N lines. Default 50 keeps the JSON
   * envelope bounded even on a freshly-cloned monorepo with thousands
   * of untracked files.
   */
  workingTreeStatusMaxLines?: number;
  strictGit?: boolean;
}

const DEFAULT_WORKING_TREE_LINES = 50;
export function buildRepoStateFromSnapshot(
  opts: RepoStateSnapshotOptions
): Promise<RepoState | null> {
  const snapshot = structuredClone({
    plan: opts.snapshot.plan,
    checkpoints: opts.snapshot.checkpoints,
    summary: opts.snapshot.summary,
  });
  const laterArtifactEvidence = structuredClone(opts.laterArtifactEvidence);
  if (!snapshot.plan) return Promise.resolve(null);
  return buildRepoStateData({ ...opts, ...snapshot, plan: snapshot.plan, laterArtifactEvidence });
}
async function buildRepoStateData(
  opts: Omit<RepoStateSnapshotOptions, 'snapshot'> & {
    plan: NonNullable<ArtifactThread['plan']>;
    checkpoints: ArtifactThread['checkpoints'];
    summary: ArtifactThread['summary'];
    laterArtifactEvidence: RepoStateSnapshotOptions['laterArtifactEvidence'];
  }
): Promise<RepoState> {
  const { plan, checkpoints, summary, repo } = opts;
  const cap = opts.workingTreeStatusMaxLines ?? DEFAULT_WORKING_TREE_LINES;

  const artifactHeadSha = summary
    ? summary.head_sha
    : checkpoints.length > 0
      ? checkpoints[checkpoints.length - 1].head_sha
      : plan.base_sha;

  const [currentBranch, currentHeadSha, rawStatus] = await Promise.all([
    repo.getCurrentBranch(),
    repo.getHeadSha(),
    repo.getWorkingTreeStatus(),
  ]);

  const workingTreeStatus = capLines(rawStatus, cap);
  const workingTreeDirty = rawStatus.length > 0;
  const headMatchesArtifact = artifactHeadSha === currentHeadSha;

  // Union of agent-declared files across all checkpoints. Bounded by
  // checkpoint count; cheap.
  const artifactFiles = new Set<string>();
  for (const cp of checkpoints) {
    if (cp.status !== 'closed') continue;
    for (const f of cp.files_changed) artifactFiles.add(f);
  }

  const commits_since_artifact_head_touching_artifact_files: RepoStateCommit[] = [];
  if (!headMatchesArtifact && artifactHeadSha && artifactFiles.size > 0) {
    const range = opts.strictGit
      ? await repo.getCommitsBetweenStrict(artifactHeadSha, currentHeadSha)
      : await repo.getCommitsBetween(artifactHeadSha, currentHeadSha);
    for (const c of range) {
      const matched = c.files.filter((f) => artifactFiles.has(f));
      if (matched.length > 0) {
        commits_since_artifact_head_touching_artifact_files.push({
          sha: c.sha,
          subject: c.subject,
          files: matched,
        });
      }
    }
  }

  const open_items_addressed_since = await buildOpenItemEvidence({
    laterArtifactEvidence: opts.laterArtifactEvidence,
    artifactFiles,
    summaryOpenItems: summary?.open_items ?? [],
    rangeCommits: commits_since_artifact_head_touching_artifact_files,
  });

  return {
    current_branch: currentBranch,
    current_head_sha: currentHeadSha,
    artifact_head_sha: artifactHeadSha,
    head_matches_artifact: headMatchesArtifact,
    working_tree_dirty: workingTreeDirty,
    working_tree_status: workingTreeStatus,
    commits_since_artifact_head_touching_artifact_files,
    open_items_addressed_since,
  };
}

interface OpenItemEvidenceOptions {
  laterArtifactEvidence: RepoStateSnapshotOptions['laterArtifactEvidence'];
  artifactFiles: Set<string>;
  summaryOpenItems: string[];
  rangeCommits: RepoStateCommit[];
}

async function buildOpenItemEvidence(opts: OpenItemEvidenceOptions): Promise<OpenItemEvidence[]> {
  if (opts.summaryOpenItems.length === 0) return [];
  if (opts.artifactFiles.size === 0) return [];

  // Evidence kind 1: files modified in commits since artifact_head_sha.
  // Aggregate across all in-range commits — the heuristic is artifact-
  // wide, not commit-wise.
  const filesChangedSinceHead = new Set<string>();
  for (const c of opts.rangeCommits) {
    for (const f of c.files) {
      if (opts.artifactFiles.has(f)) filesChangedSinceHead.add(f);
    }
  }

  const laterArtifactRef = opts.laterArtifactEvidence;

  const out: OpenItemEvidence[] = [];
  for (const item of opts.summaryOpenItems) {
    if (filesChangedSinceHead.size > 0) {
      out.push({
        item,
        evidence: { kind: 'file_changed', files: [...filesChangedSinceHead].sort() },
      });
    } else if (laterArtifactRef) {
      out.push({
        item,
        evidence: {
          kind: 'later_artifact',
          artifact_id: laterArtifactRef.artifact_id,
          files: laterArtifactRef.files,
        },
      });
    }
  }
  return out;
}

function capLines(input: string, maxLines: number): string {
  if (input.length === 0) return input;
  const lines = input.split('\n');
  if (lines.length <= maxLines) return input;
  const truncated = lines.slice(0, maxLines);
  truncated.push(`… (+${lines.length - maxLines} more lines)`);
  return truncated.join('\n');
}
