import { lineHash } from '@orcaops/core';
import {
  collectRetainedProvenanceCandidates,
  type ProvenanceCoverage,
  type ProvenanceIssue,
  ProvenanceRepository,
  provenanceSeedGuidance,
  resolveProvenance,
} from '@orcaops/core/history';
import { type HistoryIssue, HistoryScopeError } from '@orcaops/project-scope/history';
import {
  collectDatabaseHistory,
  type DatabaseHistoryScope,
  type DatabaseHistorySelection,
} from '@orcaops/project-scope/history/database';
import { canonicalJson, redactSecretsInObject } from '@orcaops/storage';
import {
  ArtifactQueryDetailsSchema,
  type ProjectCounters,
  ProjectDatabaseError,
  readProjectRationale,
  readProjectSeedState,
} from '@orcaops/storage/history/database';
import {
  historyProvenanceMayMatch,
  type HistoryProvenanceMetadata,
  HistoryProvenanceMetadataSchema,
} from '@orcaops/storage/history/metadata-row';
import { digest } from '@orcaops/storage/history/primitives';

import { artifactKnowledgeBlock } from './artifact-knowledge.js';
import {
  createContextRevalidator,
  historyGitEnvironment,
  hydrateHistoryThreads,
  requireRepositoryScope,
} from './database-branch-history.js';
import type { resolveDatabaseHistoryCommandContext } from './database-history-context.js';
import { type CanonicalWhyOptions, validateCanonicalWhy } from './history-provenance.js';
import { getInvocationCwd } from './invocation-context.js';
import {
  inspectProvenanceCandidate,
  provenanceInspectionAnchor,
} from './provenance-candidate-inspection.js';
import { projectProvenanceJson } from './provenance-json.js';
import {
  detailedProvenanceCandidate,
  historicalProvenanceTask,
  provenanceTargetFacts,
} from './provenance-output.js';
import { rationaleProvenanceJson } from './provenance-rationale.js';
import { toRepoRelative } from './resolve-root.js';
import { declinedSeedAreaForPath } from '../commands/seed/state.js';

const DEFAULT_ARTIFACT_LIMIT = 500;
const DEFAULT_SUPPORT_LIMIT = 500;

function issue(cause: unknown, projectId: string): HistoryIssue {
  const code =
    cause instanceof Error && 'code' in cause ? String(cause.code) : 'PROVENANCE_UNAVAILABLE';
  if (code === 'HISTORY_CHANGED' || code === 'STALE_CONTEXT') throw cause;
  return {
    code,
    project_id: projectId,
    message: cause instanceof Error ? cause.message : String(cause),
  };
}

function databaseScopeEnvelope(scope: DatabaseHistoryScope) {
  return {
    kind: scope.kind,
    selection: scope.selection,
    root_key: scope.root.rootKey,
    authorities: scope.projects.map((project) => ({
      project_id: project.projectId,
      store_instance_id: project.authority?.storeInstanceId ?? null,
      state: project.database ? ('available' as const) : ('unavailable' as const),
    })),
    worktree_id: scope.gitContext?.worktreeId ?? null,
    branch: structuredClone(scope.branch),
  };
}

function projectScope(scope: DatabaseHistoryScope): DatabaseHistoryScope {
  return {
    ...scope,
    kind: 'project',
    branch: { value: null, source: 'all' },
  };
}

function selectedCounters(
  collection: ReturnType<typeof collectDatabaseHistory>,
  projectId: string
): ProjectCounters {
  const source = collection.sources.filter((entry) => entry.projectId === projectId);
  if (source.length !== 1)
    throw new ProjectDatabaseError(
      'HISTORY_INACCESSIBLE',
      'The selected project database did not provide one exact metadata snapshot'
    );
  return source[0].counters;
}

function assertSameSequence(actual: ProjectCounters, expected: ProjectCounters): void {
  if (
    actual.writeSequence !== expected.writeSequence ||
    actual.intentChangeCounter !== expected.intentChangeCounter
  )
    throw new ProjectDatabaseError(
      'STALE_CONTEXT',
      'Project history changed during provenance selection; retry the original query'
    );
}

function provenance(entry: DatabaseHistorySelection): HistoryProvenanceMetadata {
  try {
    return HistoryProvenanceMetadataSchema.parse(JSON.parse(entry.row.provenanceJson!));
  } catch (cause) {
    throw new ProjectDatabaseError(
      'HISTORY_INTEGRITY_REQUIRED',
      'Selected provenance metadata is invalid; explicitly rebuild it from original history',
      { cause }
    );
  }
}

function details(entry: DatabaseHistorySelection) {
  try {
    return ArtifactQueryDetailsSchema.parse(JSON.parse(entry.row.detailsJson!));
  } catch (cause) {
    throw new ProjectDatabaseError(
      'HISTORY_INTEGRITY_REQUIRED',
      'Selected provenance details are invalid; explicitly rebuild them from original history',
      { cause }
    );
  }
}

function revisionToken(entry: DatabaseHistorySelection): string {
  return digest(
    canonicalJson({
      artifactId: entry.row.artifactId,
      generation: entry.row.generation,
      orderedHash: entry.row.orderedHash,
      eventCount: entry.row.eventCount,
      byteLength: entry.row.byteLength,
      tailEventId: entry.row.tailEventId,
    })
  );
}

function retainedIssue(problem: {
  artifact_id: string;
  code: string;
  message: string;
}): ProvenanceIssue {
  return {
    artifact_id: problem.artifact_id,
    source_event_id: null,
    code: problem.code,
    message: problem.message,
  };
}

function supportIds(threads: ReturnType<typeof hydrateHistoryThreads>['threads']) {
  return new Set(
    threads.flatMap(({ thread }) =>
      thread.checkpoints.flatMap((checkpoint) =>
        checkpoint.status === 'closed'
          ? (checkpoint.window_overlap?.cross_artifact_siblings ?? []).map(
              (sibling) => sibling.artifact_id
            )
          : []
      )
    )
  );
}

function boundedLimit(value: number | undefined, fallback: number, label: string): number {
  const limit = value ?? fallback;
  if (!Number.isSafeInteger(limit) || limit < (label === 'support' ? 0 : 1))
    throw new HistoryScopeError('INVALID_INPUT', `Provenance ${label} budget is invalid`);
  return limit;
}

export async function readDatabaseProvenance(
  context: Awaited<ReturnType<typeof resolveDatabaseHistoryCommandContext>>,
  raw: string,
  input: CanonicalWhyOptions = {},
  budgets: { maxArtifacts?: number; maxSupportArtifacts?: number } = {}
) {
  input = { ...input };
  const redactSecrets = context.config.digest.redact_secrets;
  const options = validateCanonicalWhy(raw, input);
  const { git, database, project, authority } = requireRepositoryScope(context.scope);
  if (
    (options.selector.scope !== undefined && options.selector.scope !== context.scope.kind) ||
    (options.selector.branch !== undefined &&
      options.selector.branch !== context.scope.branch.value) ||
    (options.selector.projectId !== undefined && options.selector.projectId !== project.projectId)
  )
    throw new HistoryScopeError(
      'SCOPE_CONFLICT',
      'Why options differ from the selected code project'
    );
  const maximum = boundedLimit(budgets.maxArtifacts, DEFAULT_ARTIFACT_LIMIT, 'artifact');
  const supportMaximum = boundedLimit(
    budgets.maxSupportArtifacts,
    DEFAULT_SUPPORT_LIMIT,
    'support'
  );
  const file = (await toRepoRelative(git.worktreeRoot, getInvocationCwd(), options.file))
    .split('\\')
    .join('/');
  if (
    !file ||
    file.includes('\\') ||
    file.split('/').some((part) => !part || ['.', '..', '.git'].includes(part))
  )
    throw new HistoryScopeError(
      'INVALID_INPUT',
      'Why requires a file inside the selected checkout'
    );

  const revalidate = createContextRevalidator(context.scope);
  const repository = new ProvenanceRepository(git.worktreeRoot, historyGitEnvironment());
  const target = await repository.resolveTarget({
    file,
    ...(options.line === undefined ? {} : { line: options.line }),
    ...(input.at === undefined ? {} : { at: input.at }),
  });
  await revalidate();
  const targetHash =
    target.line_content === null ? null : await lineHash('add', Buffer.from(target.line_content));

  const full = collectDatabaseHistory(
    projectScope(context.scope),
    { origin: 'all', limit: undefined, offset: 0 },
    'provenance'
  );
  const baseline = selectedCounters(full, project.projectId);
  const selected = collectDatabaseHistory(
    context.scope,
    {
      origin: options.filters.origin,
      touching: options.filters.touching,
      limit: undefined,
      offset: 0,
    },
    'provenance'
  );
  assertSameSequence(selectedCounters(selected, project.projectId), baseline);
  const indexed = selected.entries.filter((entry) =>
    historyProvenanceMayMatch(provenance(entry), { file, lineHash: targetHash })
  );
  const candidateEntries = indexed.slice(0, maximum);
  const omitted = indexed.length - candidateEntries.length;
  const hydratedCandidates = hydrateHistoryThreads(context.scope, candidateEntries, 'skip');
  for (const thread of hydratedCandidates.threads) assertSameSequence(thread.counters, baseline);

  const selectedIds = new Set(candidateEntries.map((entry) => entry.row.artifactId));
  const availableRows = new Map(full.entries.map((entry) => [entry.row.artifactId, entry]));
  const extra = [...supportIds(hydratedCandidates.threads)].filter(
    (id) => !selectedIds.has(id) && availableRows.has(id)
  );
  const supportEntries = extra.slice(0, supportMaximum).map((id) => availableRows.get(id)!);
  const supportOmitted = extra.length - supportEntries.length;
  const hydratedSupport = hydrateHistoryThreads(context.scope, supportEntries, 'skip');
  for (const thread of hydratedSupport.threads) assertSameSequence(thread.counters, baseline);

  const evidenceProblems = structuredClone(selected.completeness.issues);
  for (const entry of indexed)
    for (const code of provenance(entry).issues)
      evidenceProblems.push({
        code,
        project_id: project.projectId,
        artifact_id: entry.row.artifactId,
        message:
          'Provenance candidate index requires conservative inclusion or has unavailable original evidence',
      });
  if (supportOmitted)
    evidenceProblems.push({
      code: 'PROVENANCE_SUPPORT_OMITTED',
      project_id: project.projectId,
      count: supportOmitted,
      message: 'Overlap support exceeds the bounded hydration budget',
    });
  const hydrated = [...hydratedCandidates.threads, ...hydratedSupport.threads];
  const entriesById = new Map(
    [...candidateEntries, ...supportEntries].map((entry) => [entry.row.artifactId, entry])
  );
  const collected = await collectRetainedProvenanceCandidates({
    source: {
      root_key: authority.rootKey,
      project_id: authority.projectId,
      store_instance_id: authority.storeInstanceId,
      artifacts: hydrated.map((entry) => ({
        artifact_id: entry.artifactId,
        version_token: revisionToken(entriesById.get(entry.artifactId)!),
        artifact_generation: entry.revision.generation,
        pending: false,
        thread: entry.thread,
        execution_state: entry.executionState,
      })),
      issues: [...hydratedCandidates.skipped, ...hydratedSupport.skipped].map(retainedIssue),
    },
    artifactIds: candidateEntries.map((entry) => entry.row.artifactId),
  });
  collected.completeness.complete &&= evidenceProblems.length === 0;
  const resolution = await resolveProvenance({ target, sources: collected, repository });

  let seed: ReturnType<typeof readProjectSeedState> = null;
  const problems = structuredClone(full.completeness.issues);
  try {
    seed = readProjectSeedState(database);
    if (seed) assertSameSequence(seed.counters, baseline);
  } catch (cause) {
    problems.push(issue(cause, project.projectId));
  }
  const reportCurrent =
    seed?.coverage?.complete === true && seed.coverage.branch_sha === target.commit_sha;
  const seedState =
    seed?.completeness.complete && reportCurrent ? ('complete' as const) : ('unknown' as const);
  const declined =
    seed?.precious?.discovery_areas === undefined
      ? null
      : declinedSeedAreaForPath(seed.precious.discovery_areas, file);
  const fullRows = full.entries.map((entry) => ({
    entry,
    provenance: provenance(entry),
    details: details(entry),
  }));
  const unknownImported = fullRows.filter(
    ({ entry, details: value }) =>
      entry.row.origin === 'git-import' && !value.origin?.member_shas?.length
  ).length;
  if (unknownImported)
    problems.push({
      code: 'IMPORTED_COMMIT_COVERAGE_UNAVAILABLE',
      project_id: project.projectId,
      count: unknownImported,
      message: 'Imported artifacts lack a complete original commit membership',
    });
  const coverage: ProvenanceCoverage = {
    complete: full.completeness.complete && problems.length === 0 && seedState === 'complete',
    unknown_associations: full.entries.filter((entry) => entry.row.associationsUnknown === 1)
      .length,
    unqualified_indexes: fullRows.filter(
      ({ provenance: value }) => value.omitted || value.unavailable
    ).length,
    captured_commit: fullRows.some(
      ({ entry, details: value }) =>
        entry.row.origin === 'captured' &&
        value.anchors.some((anchor) => anchor.head_sha === target.blame.sha)
    ),
    imported_commit: fullRows.some(({ details: value }) =>
      value.origin?.member_shas?.includes(target.blame.sha ?? '')
    ),
    seed_state: seedState,
    declined_area: declined,
  };
  const guidance = provenanceSeedGuidance({
    resolution,
    coverage,
    candidatesOmitted: omitted,
    narrowed:
      context.scope.kind !== 'project' ||
      context.scope.branch.value !== null ||
      options.filters.origin !== 'all' ||
      options.filters.touching !== undefined,
  });
  assertSameSequence(database.read(() => null).counters, baseline);
  await revalidate();

  const { content: _content, line_content: _lineContent, ...codeTarget } = target;
  const limit = options.filters.limit!;
  const offset = options.filters.offset;
  const results = resolution.matches.slice(offset, offset + limit).map(detailedProvenanceCandidate);
  const best = !omitted && resolution.best ? detailedProvenanceCandidate(resolution.best) : null;
  const hasCheckpointCandidates = resolution.matches.some(
    (match) => match.candidate.checkpoint !== null
  );
  const rationaleRead = readProjectRationale(database, {
    target: { file },
    candidates: resolution.matches
      .filter(({ candidate }) => !hasCheckpointCandidates || candidate.checkpoint !== null)
      .map(({ candidate }) => ({
        artifactId: candidate.artifact_id,
        eventId: candidate.source_event_id,
        planEventId: candidate.plan_support.source_event_id,
      })),
    boundary: options.boundary,
    observation: baseline.writeSequence,
    ...(best ? { authorityArtifactId: best.artifact_id } : {}),
  });
  assertSameSequence(rationaleRead.counters, baseline);
  const knowledge = artifactKnowledgeBlock({
    context: rationaleRead.value.context,
    plan: best?.plan_support.source_event_id
      ? { artifactId: best.artifact_id, planEventId: best.plan_support.source_event_id }
      : null,
  });
  const result = {
    schema_version: 3 as const,
    scope: databaseScopeEnvelope(context.scope),
    code_revision: target.commit_sha,
    target: codeTarget,
    filters: { origin: options.filters.origin, touching: options.filters.touching ?? null },
    conclusion: omitted ? ('incomplete' as const) : resolution.conclusion,
    best,
    // Path comparisons must precede redaction, which can collapse distinct secret-bearing paths.
    target_facts: {
      best: best === null ? null : provenanceTargetFacts(best, file),
      results: results.map((row) => provenanceTargetFacts(row, file)),
    },
    results,
    selected_candidate: input.candidate
      ? (resolution.matches
          .filter(
            ({ candidate }) =>
              `${candidate.artifact_id}:${candidate.source_event_id}` === input.candidate
          )
          .map(detailedProvenanceCandidate)[0] ?? null)
      : null,
    completeness: {
      complete: resolution.completeness.complete,
      issues: [
        ...evidenceProblems,
        ...resolution.completeness.issues.map((problem) => ({
          ...problem,
          project_id: project.projectId,
        })),
      ],
    },
    pagination: {
      offset,
      limit,
      total: resolution.matches.length,
      has_more: offset + results.length < resolution.matches.length,
    },
    candidate_selection: {
      indexed: indexed.length,
      materialized: candidateEntries.length,
      support_materialized: supportEntries.length,
      support_omitted: supportOmitted,
      omitted,
      complete: omitted === 0,
    },
    project_coverage: {
      ...coverage,
      captured_artifacts: full.availableCounts.captured,
      imported_artifacts: full.availableCounts.imported,
      inventory_token: digest(
        canonicalJson(
          full.entries.map((entry) => ({
            artifactId: entry.row.artifactId,
            versionToken: revisionToken(entry),
          }))
        )
      ),
      generation_token: digest(canonicalJson({ projectId: project.projectId, ...baseline })),
      seed_witness_token: seed?.revision.contentHash ?? null,
      issues: problems,
    },
    knowledge,
    rationale: rationaleRead.value,
    source_versions: resolution.source_versions,
    integrity: { selection: 'metadata', candidates: 'verified' },
    uncertainty: [
      ...resolution.uncertainty,
      ...(omitted ? ['Candidate budget prevents a complete provenance ranking'] : []),
    ],
    seed_guidance: guidance,
  };
  return redactSecrets ? redactSecretsInObject(result) : result;
}

export async function readDatabaseCanonicalWhy(
  context: Awaited<ReturnType<typeof resolveDatabaseHistoryCommandContext>>,
  raw: string,
  input: CanonicalWhyOptions = {},
  budgets: { maxArtifacts?: number; maxSupportArtifacts?: number } = {}
) {
  const options = { ...input };
  const result = await readDatabaseProvenance(context, raw, options, budgets);
  if (options.candidate) return inspectProvenanceCandidate(result, options);
  return rationaleProvenanceJson(
    projectProvenanceJson(result, true),
    result.rationale,
    options,
    new Map(
      [...(result.best ? [result.best] : []), ...result.results].map((row) => [
        `${row.artifact_id}:${row.source_event_id}`,
        historicalProvenanceTask(row),
      ])
    ),
    { anchor: provenanceInspectionAnchor(result) }
  );
}
