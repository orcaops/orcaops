import {
  type ArchivedArtifactThread,
  type ArtifactOriginKind,
  type ArtifactState,
  loadArtifactThreadFromArchive,
  type Store,
} from '@orcaops/storage';

import {
  selectProjectArtifacts,
  unavailableArtifactIdsWithoutSelectedProjection,
} from './artifact-projections.js';
import type { buildContext } from './context.js';
import { readForEnumeration } from './enumeration-read.js';
import { fallbackState } from './lifecycle-state.js';
import type { ProjectHandle } from './project-scope.js';
import { ErrorCodes, OrcaopsError } from '../io/errors.js';
import { writeTerminalSafeStderr } from '../io/output.js';

type CliContext = Awaited<ReturnType<typeof buildContext>>;

export type RangeAnchorSource = 'checkpoint' | 'summary' | 'pre_pr';

export interface RangeAnchor {
  source: RangeAnchorSource;
  n?: number;
  head_sha: string;
}

export interface RangeArtifact {
  id: string;
  label: string;
  task: string;
  branch: string;
  state: ArtifactState;
  started_at: string;
  completed_at: string | null;
  anchors: RangeAnchor[];
  matched_anchors: RangeAnchor[];
  origin: ArtifactOriginKind | null;
  order: number;
  relationship: 'in_range';
  projection:
    | { source: 'hot'; store: Store }
    | { source: 'archive'; store: Store; thread: ArchivedArtifactThread };
}

export type RangeRelationshipReason =
  | 'in_range'
  | 'reachable_out_of_range'
  | 'unreachable_from_head'
  | 'unverifiable';

interface RangeCandidateBase {
  id: string;
  started_at: string;
  origin: ArtifactOriginKind | null;
}

export type RangeCandidate =
  | (RangeCandidateBase & {
      kind: 'lineage_candidate';
      label: string;
      branch: string;
      reason: Exclude<RangeRelationshipReason, 'in_range'>;
    })
  | (RangeCandidateBase & {
      kind: 'unreadable';
      label: null;
      branch: null;
      reason: 'unverifiable';
    });

export interface ResolvedArtifactRange {
  from_sha: string;
  to_sha: string;
  commit_shas: string[];
  matched: RangeArtifact[];
  candidates: RangeCandidate[];
}

export async function classifyRangeRelationship(input: {
  anchors: readonly RangeAnchor[];
  rangeShas: ReadonlySet<string>;
  headSha: string;
  checkReachability: (
    anchor: string,
    head: string
  ) => Promise<'reachable' | 'unreachable' | 'unknown'>;
}): Promise<RangeRelationshipReason> {
  if (input.anchors.some((anchor) => input.rangeShas.has(anchor.head_sha))) return 'in_range';
  if (input.anchors.length === 0) return 'unverifiable';
  const reachability = await Promise.all(
    input.anchors.map((anchor) => input.checkReachability(anchor.head_sha, input.headSha))
  );
  if (reachability.includes('unknown')) return 'unverifiable';
  return reachability.includes('reachable') ? 'reachable_out_of_range' : 'unreachable_from_head';
}

export function chronologicalOrderForAnchors(
  anchors: readonly RangeAnchor[],
  chronologicalIndex: ReadonlyMap<string, number>
): number {
  const indexes = anchors.map((anchor) => {
    const index = chronologicalIndex.get(anchor.head_sha);
    if (index === undefined) {
      throw new OrcaopsError(
        ErrorCodes.INTERNAL,
        `In-range anchor "${anchor.head_sha}" is missing from the chronological range index.`
      );
    }
    return index;
  });
  return Math.min(...indexes);
}

export async function selectArtifactsInRange(input: {
  ctx: CliContext;
  project: ProjectHandle;
  fromSha: string;
  toSha: string;
  localBranch: string | null;
  state?: ArtifactState;
  operation?: string;
}): Promise<ResolvedArtifactRange> {
  const commitShas = await input.ctx.repo.listCommitShasBetween(input.fromSha, input.toSha);
  const rangeSet = new Set(commitShas);
  const chronologicalIndex = new Map(
    [...commitShas].reverse().map((sha, index) => [sha, index] as const)
  );
  const matched: RangeArtifact[] = [];
  const candidates: RangeCandidate[] = [];
  const selectedArtifacts = await selectProjectArtifacts(input.project);
  const unavailableIds = unavailableArtifactIdsWithoutSelectedProjection(
    input.project.issues,
    selectedArtifacts
  );
  for (const id of unavailableIds) {
    candidates.push({
      kind: 'unreadable',
      id,
      label: null,
      branch: null,
      started_at: '',
      reason: 'unverifiable',
      origin: null,
    });
  }

  for (const selected of selectedArtifacts) {
    const row = selected.row;
    const operation = input.operation ?? 'artifact range selection';
    let checkpoints;
    let summary;
    let artifact;
    let projection: RangeArtifact['projection'];
    if (selected.source === 'hot') {
      const summaryRead =
        selected.hotReadError === undefined
          ? await readForEnumeration(row.id, operation, () => input.ctx.store.readSummary(row.id))
          : await readForEnumeration(row.id, operation, () =>
              Promise.reject(selected.hotReadError)
            );
      const artifactRead =
        summaryRead.kind === 'unreadable'
          ? summaryRead
          : await readForEnumeration(row.id, operation, () => input.ctx.store.readArtifact(row.id));
      if (summaryRead.kind === 'unreadable' || artifactRead.kind === 'unreadable') {
        candidates.push({
          kind: 'unreadable',
          id: row.id,
          label: null,
          branch: null,
          started_at: row.started_at,
          reason: 'unverifiable',
          origin: row.origin_kind ?? null,
        });
        continue;
      }
      checkpoints = input.ctx.store.store.getCheckpoints(row.id);
      summary = summaryRead.value;
      artifact = artifactRead.value;
      projection = { source: 'hot', store: selected.store };
    } else {
      const threadRead = await readForEnumeration(row.id, operation, () =>
        loadArtifactThreadFromArchive(input.project.projectDir, row.id)
      );
      if (threadRead.kind === 'unreadable' || threadRead.value.lossyLines > 0) {
        if (threadRead.kind !== 'unreadable') {
          writeTerminalSafeStderr(
            `warning: artifact ${row.id} is unreadable in ${operation} — the archive copy ` +
              `has ${threadRead.value.lossyLines} corrupt event-log line(s)\n`
          );
        }
        candidates.push({
          kind: 'unreadable',
          id: row.id,
          label: null,
          branch: null,
          started_at: row.started_at,
          reason: 'unverifiable',
          origin: row.origin_kind ?? null,
        });
        continue;
      }
      const thread = threadRead.value;
      checkpoints = thread.checkpoints;
      summary = thread.summary;
      artifact = thread.artifactJson;
      projection = { source: 'archive', store: selected.store, thread };
    }

    if (!artifact) {
      candidates.push({
        kind: 'unreadable',
        id: row.id,
        label: null,
        branch: null,
        started_at: row.started_at,
        reason: 'unverifiable',
        origin: row.origin_kind ?? null,
      });
      continue;
    }

    const state = artifact.state ?? fallbackState(row.status);
    if (input.state !== undefined && state !== input.state) continue;
    const lineageMatches =
      input.localBranch !== null &&
      artifact.branch_lineage.some((entry) => entry.branch === input.localBranch);

    const anchors: RangeAnchor[] = checkpoints.map((cp) => ({
      source: 'checkpoint',
      n: cp.n,
      head_sha: cp.head_sha,
    }));
    if (summary?.head_sha) {
      anchors.push({ source: 'summary', head_sha: summary.head_sha });
    }
    if (artifact?.pre_pr_checked_head_sha) {
      anchors.push({ source: 'pre_pr', head_sha: artifact.pre_pr_checked_head_sha });
    }
    const matchedAnchors = anchors.filter((anchor) => rangeSet.has(anchor.head_sha));
    if (matchedAnchors.length > 0) {
      const order = chronologicalOrderForAnchors(matchedAnchors, chronologicalIndex);
      matched.push({
        id: row.id,
        label: row.label ?? 'unlabelled',
        task: row.task,
        branch: row.branch,
        state,
        started_at: row.started_at,
        completed_at: row.completed_at ?? null,
        anchors,
        matched_anchors: matchedAnchors,
        origin: row.origin_kind ?? null,
        order,
        relationship: 'in_range',
        projection,
      });
      continue;
    }

    if (!lineageMatches) continue;
    const reason = await classifyRangeRelationship({
      anchors,
      rangeShas: rangeSet,
      headSha: input.toSha,
      checkReachability: (anchor, head) => input.ctx.repo.checkReachability(anchor, head),
    });
    if (reason === 'in_range') continue;
    candidates.push({
      kind: 'lineage_candidate',
      id: row.id,
      label: row.label ?? 'unlabelled',
      branch: row.branch,
      started_at: row.started_at,
      reason,
      origin: row.origin_kind ?? null,
    });
  }

  matched.sort((a, b) =>
    a.order !== b.order
      ? a.order - b.order
      : a.started_at !== b.started_at
        ? a.started_at.localeCompare(b.started_at)
        : a.id.localeCompare(b.id)
  );
  candidates.sort((a, b) =>
    a.started_at !== b.started_at
      ? a.started_at.localeCompare(b.started_at)
      : a.id.localeCompare(b.id)
  );
  return {
    from_sha: input.fromSha,
    to_sha: input.toSha,
    commit_shas: commitShas,
    matched,
    candidates,
  };
}

export interface BranchDigestRange {
  branch: string;
  head_ref: string;
  head_sha: string;
  base: string;
  base_sha: string;
  merge_base: string;
}

export async function resolveBranchDigestRange(input: {
  ctx: CliContext;
  branch?: string;
  base?: string;
}): Promise<BranchDigestRange> {
  const branch = input.branch ?? (await input.ctx.repo.getCurrentBranch());
  if (branch === '' || branch === 'HEAD') {
    throw new OrcaopsError(
      ErrorCodes.INVALID_INPUT,
      'Branch-wide digest requires a local branch; HEAD is detached.',
      'branch'
    );
  }
  const presence = await input.ctx.repo.branchPresence(branch);
  if (presence === 'absent') {
    throw new OrcaopsError(
      ErrorCodes.INVALID_INPUT,
      `No local branch named "${branch}".`,
      'branch'
    );
  }
  if (presence === 'unknown') {
    throw new OrcaopsError(
      ErrorCodes.INTERNAL,
      `Could not determine whether local branch "${branch}" exists.`
    );
  }
  const headRef = `refs/heads/${branch}`;
  const head = await input.ctx.repo.resolveCommitState(headRef);
  if (head.status !== 'resolved') {
    throw new OrcaopsError(
      head.status === 'absent' ? ErrorCodes.INVALID_INPUT : ErrorCodes.INTERNAL,
      `Could not resolve local branch "${branch}" to a commit.`,
      head.status === 'absent' ? 'branch' : undefined
    );
  }

  const base = input.base ?? (await discoverDefaultBase(input.ctx));
  const baseResolution = await input.ctx.repo.resolveCommitState(base);
  if (baseResolution.status !== 'resolved') {
    throw new OrcaopsError(
      baseResolution.status === 'absent' ? ErrorCodes.INVALID_INPUT : ErrorCodes.INTERNAL,
      `Could not resolve base "${base}" to a commit.`,
      baseResolution.status === 'absent' ? 'base' : undefined
    );
  }
  const mergeBase = await input.ctx.repo.resolveMergeBase(baseResolution.sha, head.sha);
  if (mergeBase.status !== 'resolved') {
    throw new OrcaopsError(
      mergeBase.status === 'absent' ? ErrorCodes.INVALID_INPUT : ErrorCodes.INTERNAL,
      mergeBase.status === 'absent'
        ? `Could not find a merge base between "${base}" and "${branch}".`
        : `Could not determine the merge base between "${base}" and "${branch}".`,
      mergeBase.status === 'absent' ? 'base' : undefined
    );
  }
  return {
    branch,
    head_ref: headRef,
    head_sha: head.sha,
    base,
    base_sha: baseResolution.sha,
    merge_base: mergeBase.sha,
  };
}

async function discoverDefaultBase(ctx: CliContext): Promise<string> {
  const originHead = await ctx.repo.resolveCommitState('refs/remotes/origin/HEAD');
  if (originHead.status === 'resolved') return 'refs/remotes/origin/HEAD';
  if (originHead.status === 'unknown') {
    throw new OrcaopsError(ErrorCodes.INTERNAL, 'Could not inspect refs/remotes/origin/HEAD.');
  }
  const [main, master] = await Promise.all([
    ctx.repo.resolveCommitState('refs/heads/main'),
    ctx.repo.resolveCommitState('refs/heads/master'),
  ]);
  if (main.status === 'unknown' || master.status === 'unknown') {
    throw new OrcaopsError(
      ErrorCodes.INTERNAL,
      'Could not discover the repository default branch.'
    );
  }
  if (main.status === 'resolved' && master.status === 'absent') return 'refs/heads/main';
  if (master.status === 'resolved' && main.status === 'absent') return 'refs/heads/master';
  throw new OrcaopsError(
    ErrorCodes.INVALID_INPUT,
    'Could not discover one unambiguous default base; pass --base <ref>.',
    'base'
  );
}
