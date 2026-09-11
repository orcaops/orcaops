import {
  adjudicateOverlapGroups,
  type ArtifactThread,
  canonicalJson,
  type CheckpointAdjudication,
  type ClosedCheckpoint,
  type DiffFingerprintManifest,
  DiffFingerprintManifestSchema,
  type Plan,
  rebuildPlanFromEvents,
  type SourcePlanPin,
} from '@orcaops/storage';
import { readExecutionState } from '@orcaops/storage/history/execution';

import {
  computeDiffFingerprintManifestHash,
  summarizeManifest,
} from '../diff-fingerprint/adapter.js';

export interface ProvenanceIssue {
  artifact_id: string;
  source_event_id: string | null;
  code: string;
  message: string;
}

export interface ProvenancePlanSupport {
  anchor_event_id: string;
  source_event_id: string | null;
  content_event_id: string | null;
  state: 'available' | 'unavailable';
  plan: Plan | null;
}

export interface ProvenanceCandidate {
  root_key: string;
  project_id: string;
  store_instance_id: string;
  artifact_id: string;
  locator: string;
  version_token: string;
  artifact_generation: number;
  pending: boolean;
  origin: 'captured' | 'imported';
  kind: 'checkpoint' | 'plan';
  source_event_id: string;
  recorded_at: string;
  plan_support: ProvenancePlanSupport;
  source_plan: SourcePlanPin | null;
  checkpoint: ClosedCheckpoint | null;
  fingerprint: {
    state: 'available' | 'skipped' | 'unavailable';
    manifest: DiffFingerprintManifest | null;
    truncated: boolean;
  };
  overlap: CheckpointAdjudication | null;
  association: {
    worktree_ids: string[];
    unknown: boolean;
    checkpoint_worktree_id: string | null;
  };
  enrichment: {
    content_event_id: string;
    enriched_at: string;
    plan: Plan | null;
    checkpoint_summary: string | null;
  } | null;
  issues: ProvenanceIssue[];
}

export interface ProvenanceCandidates {
  candidates: ProvenanceCandidate[];
  source_versions: Array<{ artifact_id: string; version_token: string }>;
  completeness: { complete: boolean; issues: ProvenanceIssue[] };
}

export interface RetainedProvenanceArtifact {
  artifact_id: string;
  version_token: string;
  artifact_generation: number;
  pending: boolean;
  thread: ArtifactThread;
  execution_state: unknown | null;
}

export interface RetainedProvenanceSource {
  root_key: string;
  project_id: string;
  store_instance_id: string;
  artifacts: readonly RetainedProvenanceArtifact[];
  issues: readonly ProvenanceIssue[];
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function planSupport(thread: ArtifactThread, anchor: string): ProvenancePlanSupport {
  const index = thread.events.findIndex((event) => event.record.event_id === anchor);
  const event = thread.events[index];
  const prefix = thread.events.slice(0, index + 1);
  const source = prefix
    .filter((entry) => ['plan_captured', 'plan_revised'].includes(entry.record.type))
    .at(-1);
  const plan =
    event && ['plan_captured', 'plan_revised', 'git_import_enriched'].includes(event.record.type)
      ? (rebuildPlanFromEvents(prefix)?.plan ?? null)
      : null;
  return {
    anchor_event_id: anchor,
    source_event_id: plan ? (source?.record.event_id ?? null) : null,
    content_event_id: plan?.source_event_id ?? null,
    state: plan ? 'available' : 'unavailable',
    plan,
  };
}

function checkpoints(thread: ArtifactThread) {
  return thread.checkpoints.map((checkpoint) => ({
    n: checkpoint.n,
    status: checkpoint.status,
    filesChanged: checkpoint.status === 'closed' ? checkpoint.files_changed : [],
    ...(checkpoint.status === 'closed' && checkpoint.window_overlap
      ? { windowOverlap: checkpoint.window_overlap }
      : {}),
  }));
}

async function fingerprint(
  checkpoint: ClosedCheckpoint,
  payload: Record<string, unknown>
): Promise<ProvenanceCandidate['fingerprint']> {
  const summary = checkpoint.diff_fingerprint_summary;
  const raw = payload.diff_fingerprint_manifest;
  if (raw === undefined)
    return {
      state: summary.status === 'skipped' ? 'skipped' : 'unavailable',
      manifest: null,
      truncated: summary.status === 'truncated',
    };
  const parsed = DiffFingerprintManifestSchema.safeParse(raw);
  const hash = parsed.success ? await computeDiffFingerprintManifestHash(parsed.data) : null;
  if (
    !parsed.success ||
    hash === null ||
    parsed.data.artifact_id !== checkpoint.artifact_id ||
    parsed.data.checkpoint_n !== checkpoint.n ||
    (checkpoint.open_snapshot.tree_sha !== null &&
      parsed.data.open_tree_sha !== checkpoint.open_snapshot.tree_sha) ||
    (checkpoint.close_snapshot.tree_sha !== null &&
      parsed.data.close_tree_sha !== checkpoint.close_snapshot.tree_sha) ||
    canonicalJson(summarizeManifest(parsed.data, hash)) !== canonicalJson(summary)
  )
    return { state: 'unavailable', manifest: null, truncated: summary.status === 'truncated' };
  return { state: 'available', manifest: parsed.data, truncated: summary.status === 'truncated' };
}

export async function collectRetainedProvenanceCandidates(input: {
  source: RetainedProvenanceSource;
  artifactIds: readonly string[];
}): Promise<ProvenanceCandidates> {
  const source = structuredClone(input.source);
  const artifactIds = [...input.artifactIds];
  const candidates: ProvenanceCandidate[] = [];
  const versions = new Map<string, string>();
  const threads = new Map<string, ArtifactThread>();
  const issues: ProvenanceIssue[] = structuredClone([...source.issues]);
  const retained = new Map<string, RetainedProvenanceArtifact>();
  for (const artifact of source.artifacts) {
    if (retained.has(artifact.artifact_id))
      throw new Error('Provenance source repeats an artifact identity');
    retained.set(artifact.artifact_id, artifact);
  }
  const known = new Set(retained.keys());
  const read = (id: string) => {
    let thread = threads.get(id);
    if (!thread) {
      const artifact = retained.get(id);
      if (!artifact) throw new Error('Provenance source artifact is unavailable');
      thread = artifact.thread;
      threads.set(id, thread);
      versions.set(id, artifact.version_token);
    }
    return thread;
  };
  for (const artifactId of new Set(artifactIds)) {
    if (!known.has(artifactId)) {
      if (!issues.some((issue) => issue.artifact_id === artifactId))
        issues.push({
          artifact_id: artifactId,
          source_event_id: null,
          code: 'PROVENANCE_SOURCE_UNAVAILABLE',
          message: 'Artifact is outside the available committed view',
        });
      continue;
    }
    const thread = read(artifactId);
    const eventIndices = new Map(
      thread.events.map((event, index) => [event.record.event_id, index])
    );
    const supportCache = new Map<string, ProvenancePlanSupport>();
    const supportFor = (anchor: string, opened?: string): ProvenancePlanSupport => {
      if (opened && (eventIndices.get(anchor) ?? Infinity) >= (eventIndices.get(opened) ?? -1))
        return {
          anchor_event_id: anchor,
          source_event_id: null,
          content_event_id: null,
          state: 'unavailable',
          plan: null,
        };
      let support = supportCache.get(anchor);
      if (!support) {
        support = planSupport(thread, anchor);
        supportCache.set(anchor, support);
      }
      return support;
    };
    const artifact = retained.get(artifactId)!;
    const siblingIds = new Set(
      thread.checkpoints.flatMap((checkpoint) =>
        checkpoint.status === 'closed'
          ? (checkpoint.window_overlap?.cross_artifact_siblings ?? []).map((ref) => ref.artifact_id)
          : []
      )
    );
    const siblings = new Map(
      [...siblingIds].filter((id) => known.has(id)).map((id) => [id, checkpoints(read(id))])
    );
    const unavailable = new Set([...siblingIds].filter((id) => !known.has(id)));
    const adjudications = adjudicateOverlapGroups(checkpoints(thread), siblings, unavailable);
    let execution: ReturnType<typeof readExecutionState> | null = null;
    try {
      execution = readExecutionState(artifact.execution_state);
      if (execution.artifact_id !== artifactId) execution = null;
    } catch {
      // Narrative remains readable when historical execution attribution is unavailable.
    }
    const planEvents = thread.events.filter((event) =>
      ['plan_captured', 'plan_revised'].includes(event.record.type)
    );
    const latestPlanSource = planEvents.at(-1)?.record.event_id;
    const sources = [
      ...planEvents.map((event) => ({ event, checkpoint: null as ClosedCheckpoint | null })),
      ...thread.checkpoints.flatMap((checkpoint) => {
        if (checkpoint.status !== 'closed') return [];
        const event = thread.events.find(
          (entry) => entry.record.event_id === checkpoint.source_event_ids.closed
        );
        if (!event) {
          issues.push({
            artifact_id: artifactId,
            source_event_id: checkpoint.source_event_ids.closed,
            code: 'PROVENANCE_CLOSE_UNAVAILABLE',
            message: 'Recorded checkpoint close is absent from the committed view',
          });
          return [];
        }
        return [{ event, checkpoint }];
      }),
    ];
    for (const { event, checkpoint } of sources) {
      const payload = object(event.payload);
      const support = supportFor(
        checkpoint?.open_plan_revision_event_id ?? event.record.event_id,
        checkpoint?.source_event_ids.opened
      );
      const ownIssues: ProvenanceIssue[] = [];
      const issue = (code: string, message: string) =>
        ownIssues.push({
          artifact_id: artifactId,
          source_event_id: event.record.event_id,
          code,
          message,
        });
      if (support.state === 'unavailable')
        issue(
          'PROVENANCE_OPEN_PLAN_UNAVAILABLE',
          'Original recorded plan revision cannot be resolved'
        );
      const manifest = checkpoint
        ? await fingerprint(checkpoint, payload)
        : { state: 'skipped' as const, manifest: null, truncated: false };
      if (manifest.state === 'unavailable')
        issue(
          'PROVENANCE_FINGERPRINT_UNAVAILABLE',
          'Committed fingerprint is missing or does not match its recorded summary'
        );
      const overlap = checkpoint ? (adjudications.get(checkpoint.n) ?? null) : null;
      if (overlap?.unreadableSiblingArtifacts.length)
        issue(
          'PROVENANCE_OVERLAP_UNAVAILABLE',
          'Recorded overlapping artifact evidence is unavailable'
        );
      const contentId =
        checkpoint?.source_event_id ??
        (event.record.event_id === latestPlanSource ? thread.plan?.source_event_id : null);
      const enrichmentEvent = thread.events.find(
        (entry) =>
          entry.record.event_id === contentId && entry.record.type === 'git_import_enriched'
      );
      candidates.push({
        root_key: source.root_key,
        project_id: source.project_id,
        store_instance_id: source.store_instance_id,
        artifact_id: artifactId,
        locator: `${source.project_id}/${artifactId}/${event.record.event_id}`,
        version_token: versions.get(artifactId)!,
        artifact_generation: artifact.artifact_generation,
        pending: artifact.pending,
        origin: thread.plan?.origin?.kind === 'git-import' ? 'imported' : 'captured',
        kind: checkpoint ? 'checkpoint' : 'plan',
        source_event_id: event.record.event_id,
        recorded_at: event.record.ts,
        plan_support: support,
        source_plan: thread.artifactJson?.source_plan ?? null,
        checkpoint: checkpoint
          ? {
              ...checkpoint,
              summary: String(payload.summary),
              source_event_id: event.record.event_id,
            }
          : null,
        fingerprint: manifest,
        overlap,
        association: {
          worktree_ids: execution?.associations ?? [],
          unknown: execution === null || execution.associations_unknown,
          checkpoint_worktree_id: checkpoint
            ? (execution?.checkpoint_execution.find(
                (entry) => entry.checkpoint_event_id === checkpoint.source_event_ids.opened
              )?.context.worktree_id ?? null)
            : null,
        },
        enrichment: enrichmentEvent
          ? {
              content_event_id: enrichmentEvent.record.event_id,
              enriched_at: String(object(enrichmentEvent.payload).enriched_at),
              plan: thread.plan,
              checkpoint_summary: checkpoint?.summary ?? null,
            }
          : null,
        issues: ownIssues,
      });
      issues.push(...ownIssues);
    }
  }
  return structuredClone({
    candidates,
    source_versions: [...versions]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([artifact_id, version_token]) => ({ artifact_id, version_token })),
    completeness: { complete: issues.length === 0, issues },
  });
}
