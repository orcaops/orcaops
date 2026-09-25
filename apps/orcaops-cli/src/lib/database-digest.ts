import {
  type BranchArtifactAnchor,
  BranchDigestInputError,
  buildBranchDigestData,
  buildThreadDigest,
  type DigestOutput,
  renderBranchDigestMarkdown,
  type Repo,
} from '@orcaops/core';
import { discoverEvaluators } from '@orcaops/evaluator-runner';
import {
  HistoryScopeError,
  unavailableProjectError,
  validateHistorySelector,
} from '@orcaops/project-scope/history';
import {
  collectDatabaseHistory,
  type DatabaseHistoryScope,
  resolveDatabaseHistoryOverview,
} from '@orcaops/project-scope/history/database';
import { redactSecretsInObject } from '@orcaops/storage';
import {
  ProjectDatabaseError,
  readProjectUsageAccounting,
} from '@orcaops/storage/history/database';
import { HistoryMetadataDetailsSchema } from '@orcaops/storage/history/metadata-row';
import {
  aggregateCanonicalUsage,
  estimateArtifactUsage,
} from '@orcaops/storage/history/usage-accounting';

import {
  artifactKnowledgeBlock,
  knowledgeBoundaryOption,
  knowledgeDigestSection,
  planInView,
} from './artifact-knowledge.js';
import { renderCanonicalUsageLines } from './canonical-usage-display.js';
import {
  branchSelectionScope,
  collectBranchHistory,
  createContextRevalidator,
  historyRepository,
  hydrateHistoryThreads,
  requireRepositoryScope,
} from './database-branch-history.js';
import type { resolveDatabaseHistoryCommandContext } from './database-history-context.js';
import { inspectDatabaseTasks } from './database-task-context.js';
import { CLI_ROOT } from './evaluators-config.js';
import { artifactKnowledgeUses } from './plan-knowledge-uses.js';
import { ErrorCodes, OrcaopsError } from '../io/errors.js';

export interface DatabaseDigestOptions {
  artifact?: string;
  /** Positional artifact id — equivalent to `--artifact`; both must agree. */
  artifactArg?: string;
  project?: string;
  branch?: string;
  out?: string;
  format?: 'md' | 'json';
  json?: boolean;
  branchWide?: boolean;
  base?: string;
  primaryArtifact?: string;
  /** The write sequence the continuing-knowledge answer is read at. Absent means now. */
  atBoundary?: number;
}

const DIGEST_KEYS = [
  'artifact',
  'artifactArg',
  'project',
  'branch',
  'out',
  'format',
  'json',
  'branchWide',
  'base',
  'primaryArtifact',
  'atBoundary',
] as const;

export function validateDatabaseDigest(raw: DatabaseDigestOptions = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new HistoryScopeError('INVALID_INPUT', 'Provide digest options as an object');
  const options = { ...raw };
  for (const key of Object.keys(options))
    if (!(DIGEST_KEYS as readonly string[]).includes(key))
      throw new OrcaopsError(ErrorCodes.INVALID_INPUT, `Unsupported digest option "${key}"`, key);
  if (
    options.artifact !== undefined &&
    options.artifactArg !== undefined &&
    options.artifact !== options.artifactArg
  )
    throw new OrcaopsError(
      ErrorCodes.INVALID_INPUT,
      `Conflicting artifact ids: positional "${options.artifactArg}" vs --artifact "${options.artifact}".`,
      'artifact'
    );
  if (options.artifactArg !== undefined) options.artifact ??= options.artifactArg;
  if (
    options.branchWide !== true &&
    (options.base !== undefined || options.primaryArtifact !== undefined)
  )
    throw new OrcaopsError(
      ErrorCodes.INVALID_INPUT,
      '--base and --primary-artifact require --branch-wide.',
      'branch-wide'
    );
  if (options.branchWide === true && options.artifact !== undefined)
    throw new OrcaopsError(
      ErrorCodes.INVALID_INPUT,
      '--branch-wide cannot be combined with an artifact selector.',
      'artifact'
    );
  if (options.branchWide !== true && options.artifact !== undefined && options.branch !== undefined)
    throw new OrcaopsError(
      'SCOPE_CONFLICT',
      'An exact artifact digest accepts project qualification only',
      'branch'
    );
  if (options.format !== undefined && !['md', 'json'].includes(options.format))
    throw new OrcaopsError(ErrorCodes.INVALID_INPUT, 'Digest format must be md or json', 'format');
  // A branch-wide digest spans many threads and takes no single boundary: one answer over several
  // artifacts would name a boundary for a thread it was never read against.
  if (options.branchWide === true && options.atBoundary !== undefined)
    throw new OrcaopsError(
      ErrorCodes.INVALID_INPUT,
      '--at-boundary reads one artifact; it cannot be combined with --branch-wide.',
      'at-boundary'
    );
  knowledgeBoundaryOption(options.atBoundary);
  if (options.artifact !== undefined && !/^[0-9a-f-]{1,36}$/iu.test(options.artifact))
    throw new OrcaopsError(
      ErrorCodes.INVALID_INPUT,
      'Provide an artifact UUID or hexadecimal prefix',
      'artifact'
    );
  // Selection reads a branch collection; hydration is an exact read of the one artifact
  // it lands on, so the scope profile is the collection the selection needs.
  const profile =
    options.branchWide === true ? 'git-history' : options.artifact ? 'exact' : 'collection';
  const selector = {
    projectId: options.project,
    ...(options.branchWide === true || options.artifact !== undefined
      ? {}
      : { branch: options.branch }),
  };
  validateHistorySelector({ profile, selector });
  return { options, selector, profile } as const;
}

export type DigestEvaluatorDescriptions = ReadonlyMap<string, string>;

/**
 * Evaluator descriptions decorate non-pass process notes. Lenient discovery: a
 * misconfigured pack must not stop a read (doctor surfaces those errors).
 */
export async function digestEvaluatorDescriptions(
  repoRoot: string
): Promise<DigestEvaluatorDescriptions> {
  const { evaluators } = await discoverEvaluators(repoRoot, {
    cliRoot: CLI_ROOT,
    onError: () => undefined,
  });
  const descriptions = new Map<string, string>();
  for (const evaluator of evaluators)
    if (evaluator.description !== undefined) descriptions.set(evaluator.ref, evaluator.description);
  return descriptions;
}

/**
 * The exact-artifact digest read behind `orcaops digest --artifact <id>`, exposed so
 * the summary/finish finalizer renders a completed artifact's digest through the same
 * database path rather than reporting it unavailable. Pure read: it never caches.
 */
export async function renderDatabaseArtifactDigest(
  context: Awaited<ReturnType<typeof resolveDatabaseHistoryCommandContext>>,
  artifactId: string,
  env: NodeJS.ProcessEnv,
  worktreeRoot: string
): Promise<Awaited<ReturnType<typeof readDatabaseArtifactDigest>>> {
  const prepared = validateDatabaseDigest({ artifact: artifactId });
  const descriptions = await digestEvaluatorDescriptions(worktreeRoot);
  return readDatabaseArtifactDigest(context, prepared, env, descriptions);
}

/**
 * The canonical usage envelope replaces the legacy ledger-derived `DigestUsage`:
 * incomplete sessions cannot yield exact totals, so the accounting status and its
 * reasons must reach the reader rather than a silently-partial scalar sum.
 */
function usageSection(usage: Parameters<typeof renderCanonicalUsageLines>[0]): string {
  return [
    '## agent usage',
    '',
    ...renderCanonicalUsageLines(usage).map((line) => `- ${line}`),
    '',
  ].join('\n');
}
function canonicalArtifactUsage(target: {
  projectId: string;
  artifactId: string;
  usage: Parameters<typeof aggregateCanonicalUsage>[0][number];
}) {
  return {
    accounting: aggregateCanonicalUsage([target.usage]),
    estimates: [
      {
        project_id: target.projectId,
        artifact_id: target.artifactId,
        estimate: estimateArtifactUsage(target.usage.events, target.artifactId),
      },
    ],
  };
}

export const DIGEST_SIBLING_LIMIT = 20;

/**
 * Live siblings first, then imported ones, capped: an imported corpus can run to
 * hundreds of artifacts and would otherwise bury the live work a reviewer is looking for.
 */
export function selectDigestSiblingRows<T extends { origin?: 'captured' | 'git-import' }>(
  rows: readonly T[]
): T[] {
  return [
    ...rows.filter((row) => row.origin !== 'git-import'),
    ...rows.filter((row) => row.origin === 'git-import'),
  ].slice(0, DIGEST_SIBLING_LIMIT);
}

export interface DigestSibling {
  id: string;
  state: string | null;
  unreadable?: true;
  label?: string;
  origin: 'git-import' | null;
}
export interface DigestSelection {
  artifactId: string;
  via: 'explicit' | 'pin' | 'branch';
  note?: string;
  otherArtifacts: DigestSibling[];
  otherArtifactCount: number;
}

/**
 * Default selection is summary-aware, matching the legacy contract: the valid contextual
 * pin, else the newest artifact WITH a captured summary, else the newest one with an
 * explicit in-flight note. Live work always outranks imported history, which is
 * backdated and can only ever be a last-resort target. Siblings are disclosed so a
 * reviewer never silently reads the wrong thread.
 */
function selectDigestArtifact(
  context: Awaited<ReturnType<typeof resolveDatabaseHistoryCommandContext>>,
  branch: string | undefined,
  env: NodeJS.ProcessEnv
): DigestSelection {
  const scope = context.scope;
  if (scope.projects.length !== 1 || !scope.projects[0].authority)
    throw unavailableProjectError(scope.completeness.issues, {
      code: 'PROJECT_REQUIRED',
      message: 'Implicit digest selection requires one available original project',
    });
  // The watch profile is the cheapest that carries label and task; the versions profile
  // nulls both, and the sibling disclosure names each artifact by its label.
  const collection = collectBranchHistory(scope, { branch, profile: 'watch' });
  const selectedBranch = branchSelectionScope(scope, branch).branch.value;
  if (!collection.completeness.complete && collection.entries.length === 0)
    throw unavailableProjectError(
      collection.completeness.issues,
      {
        code: 'HISTORY_INACCESSIBLE',
        message: `Branch "${selectedBranch ?? 'HEAD'}" history is unavailable; preserve it for explicit repair`,
      },
      { inputPath: 'branch' }
    );
  const rows = collection.entries;
  if (rows.length === 0)
    throw new OrcaopsError(
      'UNKNOWN_ARTIFACT',
      `No artifacts found on branch "${selectedBranch ?? 'HEAD'}". Capture a plan first.`,
      'branch'
    );
  const pinned = validContextualPin(scope, branch, env);
  const live = rows.filter((entry) => entry.row.origin !== 'git-import');
  const summarized = (pool: typeof rows) => pool.find((entry) => entry.row.state === 'summarized');
  const chosen =
    (pinned === undefined ? undefined : rows.find((entry) => entry.row.artifactId === pinned)) ??
    summarized(live) ??
    live[0] ??
    summarized(rows) ??
    rows[0];
  const siblings = rows.filter((entry) => entry.row.artifactId !== chosen.row.artifactId);
  const visible = selectDigestSiblingRows(siblings.map((entry) => entry.row));
  const hydrated = hydrateHistoryThreads(
    scope,
    siblings.filter((entry) => visible.some((row) => row.artifactId === entry.row.artifactId)),
    'skip'
  );
  const unreadable = new Set(hydrated.skipped.map((failure) => failure.artifact_id));
  return {
    artifactId: chosen.row.artifactId,
    via: pinned === chosen.row.artifactId ? 'pin' : 'branch',
    // Unreadable means unknown, never a state substituted from derived metadata.
    ...(chosen.row.state === 'summarized'
      ? {}
      : {
          note:
            `artifact ${chosen.row.artifactId} is in-flight (no summary captured yet) — ` +
            `the digest reflects work in progress`,
        }),
    otherArtifacts: visible.map((row) => ({
      id: row.artifactId,
      state: unreadable.has(row.artifactId) ? null : row.state,
      ...(unreadable.has(row.artifactId) ? { unreadable: true as const } : {}),
      ...(row.label === null ? {} : { label: row.label }),
      origin: row.origin === 'git-import' ? ('git-import' as const) : null,
    })),
    otherArtifactCount: siblings.length,
  };
}

/** The contextual task pin, only when this checkout and shell validate it. */
function validContextualPin(
  scope: DatabaseHistoryScope,
  branch: string | undefined,
  env: NodeJS.ProcessEnv
): string | undefined {
  const taskScope: DatabaseHistoryScope = {
    ...scope,
    branch:
      branch !== undefined
        ? scope.branch
        : {
            value: scope.gitContext?.branch ?? null,
            source: scope.gitContext?.branch ? 'current' : 'unavailable',
          },
  };
  const project = inspectDatabaseTasks(taskScope, env).projects[0];
  return project?.focus?.assessment.valid && project.focus.pin
    ? project.focus.pin.artifact_id
    : undefined;
}

export async function readDatabaseArtifactDigest(
  context: Awaited<ReturnType<typeof resolveDatabaseHistoryCommandContext>>,
  prepared: ReturnType<typeof validateDatabaseDigest>,
  env: NodeJS.ProcessEnv,
  evaluatorDescriptions: DigestEvaluatorDescriptions
) {
  const selection: DigestSelection =
    prepared.options.artifact === undefined
      ? selectDigestArtifact(context, prepared.options.branch, env)
      : {
          artifactId: prepared.options.artifact,
          via: 'explicit',
          otherArtifacts: [],
          otherArtifactCount: 0,
        };
  const target = resolveDatabaseHistoryOverview(context.scope, selection.artifactId, {
    boundary: knowledgeBoundaryOption(prepared.options.atBoundary),
  });
  const thread = target.artifact.thread;
  const built: DigestOutput = buildThreadDigest({
    thread,
    evaluatorDescriptions,
    redactSecrets: context.config.digest.redact_secrets,
  });
  const usage = canonicalArtifactUsage(target);
  const knowledge = artifactKnowledgeBlock({
    context: target.knowledgeContext!,
    plan: planInView(target.artifactId, artifactKnowledgeUses(target.knowledgeUses)),
  });
  const result = {
    schema_version: 3 as const,
    project_id: target.projectId,
    artifact_id: target.artifactId,
    selection: { via: selection.via },
    // An explicit --artifact emits neither the in-flight note nor siblings: the caller
    // named the thread, so there is nothing to disclose about the others.
    ...(selection.note === undefined ? {} : { note: selection.note }),
    ...(selection.otherArtifacts.length > 0 ? { other_artifacts: selection.otherArtifacts } : {}),
    ...(selection.otherArtifactCount > 0
      ? {
          other_artifact_count: selection.otherArtifactCount,
          other_artifacts_truncated: selection.otherArtifactCount > selection.otherArtifacts.length,
        }
      : {}),
    source_versions: {
      artifact: target.artifact.revision,
      execution: target.execution?.version ?? null,
    },
    data: built.data,
    knowledge,
    usage: { accounting: usage.accounting, estimates: usage.estimates },
    markdown: `${built.markdown.trimEnd()}\n\n${knowledgeDigestSection(knowledge)}\n${usageSection(usage)}`,
    sources: [{ project_id: target.projectId, counters: target.counters }],
    completeness: structuredClone(context.scope.completeness),
    integrity: { source_observation: 'read-transaction' as const },
  };
  return context.config.digest.redact_secrets ? redactSecretsInObject(result) : result;
}

export interface BranchDigestRange {
  branch: string;
  head_ref: string;
  head_sha: string;
  base: string;
  base_sha: string;
  merge_base: string;
}

async function discoverDefaultBase(repo: Repo): Promise<string> {
  const originHead = await repo.resolveCommitState('refs/remotes/origin/HEAD');
  if (originHead.status === 'resolved') return 'refs/remotes/origin/HEAD';
  if (originHead.status === 'unknown')
    throw new HistoryScopeError(
      'HISTORY_INACCESSIBLE',
      'Could not inspect refs/remotes/origin/HEAD.'
    );
  const [main, master] = await Promise.all([
    repo.resolveCommitState('refs/heads/main'),
    repo.resolveCommitState('refs/heads/master'),
  ]);
  if (main.status === 'unknown' || master.status === 'unknown')
    throw new HistoryScopeError(
      'HISTORY_INACCESSIBLE',
      'Could not discover the repository default branch.'
    );
  if (main.status === 'resolved' && master.status === 'absent') return 'refs/heads/main';
  if (master.status === 'resolved' && main.status === 'absent') return 'refs/heads/master';
  throw new OrcaopsError(
    ErrorCodes.INVALID_INPUT,
    'Could not discover one unambiguous default base; pass --base <ref>.',
    'base'
  );
}

export async function resolveDatabaseBranchRange(
  repo: Repo,
  options: { branch?: string; base?: string }
): Promise<BranchDigestRange> {
  const branch = options.branch ?? (await repo.getCurrentBranch());
  if (branch === '' || branch === 'HEAD')
    throw new OrcaopsError(
      ErrorCodes.INVALID_INPUT,
      'Branch-wide digest requires a local branch; HEAD is detached.',
      'branch'
    );
  const presence = await repo.branchPresence(branch);
  if (presence === 'absent')
    throw new OrcaopsError(
      ErrorCodes.INVALID_INPUT,
      `No local branch named "${branch}".`,
      'branch'
    );
  if (presence === 'unknown')
    throw new HistoryScopeError(
      'HISTORY_INACCESSIBLE',
      `Could not determine whether local branch "${branch}" exists.`
    );
  const headRef = `refs/heads/${branch}`;
  const head = await repo.resolveCommitState(headRef);
  if (head.status !== 'resolved')
    throw new OrcaopsError(
      head.status === 'absent' ? ErrorCodes.INVALID_INPUT : 'HISTORY_INACCESSIBLE',
      `Could not resolve local branch "${branch}" to a commit.`,
      'branch'
    );
  const base = options.base ?? (await discoverDefaultBase(repo));
  const baseResolution = await repo.resolveCommitState(base);
  if (baseResolution.status !== 'resolved')
    throw new OrcaopsError(
      baseResolution.status === 'absent' ? ErrorCodes.INVALID_INPUT : 'HISTORY_INACCESSIBLE',
      `Could not resolve base "${base}" to a commit.`,
      'base'
    );
  const mergeBase = await repo.resolveMergeBase(baseResolution.sha, head.sha);
  if (mergeBase.status !== 'resolved')
    throw new OrcaopsError(
      mergeBase.status === 'absent' ? ErrorCodes.INVALID_INPUT : 'HISTORY_INACCESSIBLE',
      mergeBase.status === 'absent'
        ? `Could not find a merge base between "${base}" and "${branch}".`
        : `Could not determine the merge base between "${base}" and "${branch}".`,
      'base'
    );
  return {
    branch,
    head_ref: headRef,
    head_sha: head.sha,
    base,
    base_sha: baseResolution.sha,
    merge_base: mergeBase.sha,
  };
}

const BranchDetailsSchema = HistoryMetadataDetailsSchema.pick({
  anchors: true,
  branchLineage: true,
});

type BranchAnchor = BranchArtifactAnchor;

export async function readDatabaseBranchDigest(
  context: Awaited<ReturnType<typeof resolveDatabaseHistoryCommandContext>>,
  prepared: ReturnType<typeof validateDatabaseDigest>,
  evaluatorDescriptions: DigestEvaluatorDescriptions
) {
  const { git, database, authority } = requireRepositoryScope(context.scope);
  const revalidate = createContextRevalidator(context.scope);
  const repo = historyRepository(git.worktreeRoot);
  await revalidate();
  const range = await resolveDatabaseBranchRange(repo, prepared.options);
  let commitShas: string[];
  try {
    commitShas = await repo.listCommitShasBetween(range.merge_base, range.head_sha);
  } catch (cause) {
    throw new ProjectDatabaseError(
      'HISTORY_INACCESSIBLE',
      'Branch range cannot be read; restore the selected repository objects and retry',
      { cause }
    );
  }
  const rangeShas = new Set(commitShas);
  const chronological = new Map(
    [...commitShas].reverse().map((sha, index) => [sha, index] as const)
  );
  await revalidate();
  const collection = collectDatabaseHistory(
    context.scope,
    { limit: undefined, offset: 0 },
    'details'
  );
  const selected: Array<{
    entry: (typeof collection.entries)[number];
    anchors: BranchAnchor[];
    matched: BranchAnchor[];
    order: number;
  }> = [];
  const lineageCandidates: Array<{
    entry: (typeof collection.entries)[number];
    anchors: BranchAnchor[];
  }> = [];
  const unreadable: BranchDigestUnreadable[] = [];
  for (const entry of collection.entries) {
    let details;
    try {
      const raw = JSON.parse(entry.row.detailsJson!) as Record<string, unknown>;
      details = BranchDetailsSchema.parse({
        anchors: raw.anchors,
        branchLineage: raw.branchLineage,
      });
    } catch {
      collection.completeness.complete = false;
      collection.completeness.issues.push({
        code: 'HISTORY_INTEGRITY_REQUIRED',
        project_id: entry.projectId,
        artifact_id: entry.row.artifactId,
        message:
          'Recorded Git anchors are unavailable; explicitly rebuild derived metadata from original history',
      });
      unreadable.push({ id: entry.row.artifactId, reason: 'unverifiable' });
      continue;
    }
    const anchors: BranchAnchor[] = details.anchors.map((anchor) => ({
      source: anchor.source,
      ...(anchor.n === undefined ? {} : { n: anchor.n }),
      head_sha: anchor.head_sha,
    }));
    const matched = anchors.filter((anchor) => rangeShas.has(anchor.head_sha));
    if (matched.length) {
      selected.push({
        entry,
        anchors,
        matched,
        order: Math.min(...matched.map((anchor) => chronological.get(anchor.head_sha)!)),
      });
      continue;
    }
    if (details.branchLineage.some((line) => line.branch === range.branch))
      lineageCandidates.push({ entry, anchors });
  }
  // Order matters: an unreadable project returns zero entries with an issue, and
  // reporting that as "no recorded work" would hide both the healthy members and the
  // integrity problem behind an empty-range answer.
  if (!collection.completeness.complete && selected.length === 0)
    throw unavailableProjectError(collection.completeness.issues, {
      code: 'HISTORY_INACCESSIBLE',
      message: 'Branch-wide history is unavailable; preserve it for explicit repair',
    });
  if (selected.length === 0)
    throw new OrcaopsError(
      'UNKNOWN_ARTIFACT',
      `No artifacts have recorded work in ${range.merge_base}..${range.head_sha}.`,
      'branch'
    );
  const excluded: BranchDigestExclusion[] = [];
  for (const candidate of lineageCandidates) {
    const reason = await classifyBranchRelationship(repo, candidate.anchors, range.head_sha);
    if (reason !== null) excluded.push({ id: candidate.entry.row.artifactId, reason });
  }
  await revalidate();
  const hydrated = hydrateHistoryThreads(
    context.scope,
    selected.map((item) => item.entry),
    'skip'
  );
  for (const failure of hydrated.skipped) {
    unreadable.push({ id: failure.artifact_id, reason: 'unverifiable' });
    collection.completeness.complete = false;
    collection.completeness.issues.push({
      code: failure.code,
      project_id: failure.project_id,
      artifact_id: failure.artifact_id,
      message: failure.message,
    });
  }
  const byId = new Map(hydrated.threads.map((thread) => [thread.artifactId, thread]));
  const artifacts = selected.flatMap((item) => {
    const thread = byId.get(item.entry.row.artifactId);
    if (!thread) return [];
    return [
      {
        data: buildThreadDigest({
          thread: thread.thread,
          evaluatorDescriptions,
          redactSecrets: context.config.digest.redact_secrets,
        }).data,
        state: item.entry.row.state,
        order: item.order,
        anchors: item.anchors,
        matched_anchors: item.matched,
      },
    ];
  });
  if (artifacts.length === 0)
    throw new ProjectDatabaseError(
      'HISTORY_INTEGRITY_REQUIRED',
      'Every selected artifact in this range is unreadable; preserve history for explicit repair'
    );
  let data: ReturnType<typeof buildBranchDigestData>;
  try {
    data = buildBranchDigestData({
      range: {
        branch: range.branch,
        base: range.base,
        base_sha: range.base_sha,
        merge_base: range.merge_base,
        head_sha: range.head_sha,
        commit_count: commitShas.length,
      },
      artifacts,
      ...(prepared.options.primaryArtifact === undefined
        ? {}
        : { primaryArtifactId: prepared.options.primaryArtifact }),
      excludedArtifacts: excluded,
      unreadableArtifacts: unreadable,
    });
  } catch (cause) {
    if (cause instanceof BranchDigestInputError)
      throw new OrcaopsError(ErrorCodes.INVALID_INPUT, cause.message, 'primary-artifact');
    throw cause;
  }
  const artifactIds = artifacts.map((artifact) => artifact.data.artifact_id);
  let usageInput: Parameters<typeof aggregateCanonicalUsage>[0][number];
  try {
    usageInput = readProjectUsageAccounting(database, {
      artifactIds,
      expectedWriteSequence: collection.sources[0]?.counters.writeSequence,
    });
  } catch (cause) {
    if (cause instanceof ProjectDatabaseError && cause.code === 'CANCELLED') throw cause;
    const message =
      cause instanceof Error ? cause.message : 'Selected project usage is unavailable';
    collection.completeness.complete = false;
    collection.completeness.issues.push({
      code: cause instanceof ProjectDatabaseError ? cause.code : 'HISTORY_INACCESSIBLE',
      project_id: authority.projectId,
      message,
    });
    usageInput = {
      projectId: authority.projectId,
      artifactIds,
      events: [],
      unavailable: [message],
    };
  }
  const usage = {
    accounting: aggregateCanonicalUsage([
      usageInput,
      ...(collection.completeness.complete
        ? []
        : [
            {
              projectId: '',
              events: [],
              unavailable: collection.completeness.issues.map((issue) => issue.message),
            },
          ]),
    ]),
    estimates: artifactIds.map((artifactId) => ({
      project_id: authority.projectId,
      artifact_id: artifactId,
      estimate: estimateArtifactUsage(usageInput.events, artifactId),
    })),
  };
  const result = {
    schema_version: 3 as const,
    project_id: collection.sources[0]?.projectId ?? null,
    mode: 'branch-wide' as const,
    data,
    usage: { accounting: usage.accounting, estimates: usage.estimates },
    markdown: `${renderBranchDigestMarkdown(data).trimEnd()}\n\n${usageSection(usage)}`,
    sources: collection.sources.map((source) => ({
      project_id: source.projectId,
      counters: source.counters,
    })),
    completeness: structuredClone(collection.completeness),
    integrity: { source_observation: 'read-transaction' as const },
  };
  return context.config.digest.redact_secrets ? redactSecretsInObject(result) : result;
}

type BranchDigestExclusion = {
  id: string;
  reason: 'reachable_out_of_range' | 'unreachable_from_head' | 'unverifiable';
};
type BranchDigestUnreadable = { id: string; reason: 'unverifiable' };

/**
 * An artifact whose recorded anchors all fall outside the range is disclosed by why:
 * reachable elsewhere on the branch, unreachable from its head, or unverifiable when
 * Git cannot answer. Missing Git objects are unavailable evidence, never a demotion
 * to partial confidence, so an unknown reachability reads as unverifiable.
 */
async function classifyBranchRelationship(
  repo: Repo,
  anchors: readonly BranchAnchor[],
  headSha: string
): Promise<BranchDigestExclusion['reason'] | null> {
  if (anchors.length === 0) return 'unverifiable';
  const reachability = await Promise.all(
    anchors.map((anchor) => repo.checkReachability(anchor.head_sha, headSha))
  );
  if (reachability.includes('unknown')) return 'unverifiable';
  return reachability.includes('reachable') ? 'reachable_out_of_range' : 'unreachable_from_head';
}
