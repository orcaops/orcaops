import { createHash } from 'node:crypto';

import type { ProvenanceCandidate, ProvenanceMatch } from '@orcaops/core/history';
import type { HistoryIssue } from '@orcaops/project-scope/history';

export const PROVENANCE_PREVIEW_ITEMS = 10;
export const PROVENANCE_PREVIEW_CHARACTERS = 240;

export interface EvidencePreview<T> {
  items: T[];
  total: number;
  omitted: number;
}

export interface TextPreview {
  text: string;
  length: number;
  truncated: boolean;
}

export type DetailedProvenanceCandidate = Omit<ProvenanceCandidate, 'fingerprint'> &
  Omit<ProvenanceMatch, 'candidate'> & {
    label: string | null;
    fingerprint: {
      state: ProvenanceCandidate['fingerprint']['state'];
      truncated: boolean;
      manifest_hash: string | null;
    };
  };

export function compactSourceVersions(
  versions: readonly { artifact_id: string; version_token: string }[]
) {
  const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  const entries = versions
    .map(({ artifact_id, version_token }) => [artifact_id, version_token] as const)
    .sort(([a, av], [b, bv]) => compare(a, b) || compare(av, bv));
  return {
    count: entries.length,
    digest: `sha256:${createHash('sha256').update(JSON.stringify(entries), 'utf8').digest('hex')}`,
  };
}

function preview<T, U>(values: readonly T[], project: (value: T) => U): EvidencePreview<U> {
  const items = values.slice(0, PROVENANCE_PREVIEW_ITEMS).map(project);
  return { items, total: values.length, omitted: values.length - items.length };
}

// Redact the complete evidence before calling these projections; a clipped secret may not match.
function textPreview(value: string): TextPreview {
  const characters = Array.from(value);
  return {
    text: characters.slice(0, PROVENANCE_PREVIEW_CHARACTERS).join(''),
    length: characters.length,
    truncated: characters.length > PROVENANCE_PREVIEW_CHARACTERS,
  };
}

type Diagnostic = Pick<HistoryIssue, 'code' | 'message'> &
  Partial<Omit<HistoryIssue, 'code' | 'message'>> & { source_event_id?: string | null };

export function compactProvenanceIssues(issues: readonly Diagnostic[]) {
  const counts = new Map<string, number>();
  for (const issue of issues) counts.set(issue.code, (counts.get(issue.code) ?? 0) + 1);
  return {
    ...preview(issues, (issue) => ({
      code: issue.code,
      ...(issue.project_id === undefined ? {} : { project_id: issue.project_id }),
      ...(issue.artifact_id === undefined ? {} : { artifact_id: issue.artifact_id }),
      ...(issue.source_event_id === undefined ? {} : { source_event_id: issue.source_event_id }),
      ...(issue.count === undefined ? {} : { count: issue.count }),
      ...(issue.resource === undefined ? {} : { resource: textPreview(issue.resource) }),
      message: textPreview(issue.message),
    })),
    distinct_codes: counts.size,
    code_counts: [...counts]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([code, count]) => ({
        code,
        count,
      })),
  };
}

export function detailedProvenanceCandidate(match: ProvenanceMatch): DetailedProvenanceCandidate {
  const c = match.candidate;
  return {
    root_key: c.root_key,
    project_id: c.project_id,
    store_instance_id: c.store_instance_id,
    artifact_id: c.artifact_id,
    locator: c.locator,
    version_token: c.version_token,
    artifact_generation: c.artifact_generation,
    pending: c.pending,
    origin: c.origin,
    kind: c.kind,
    label: c.plan_support.plan?.label ?? null,
    source_event_id: c.source_event_id,
    recorded_at: c.recorded_at,
    plan_support: c.plan_support,
    source_plan: c.source_plan,
    checkpoint: c.checkpoint,
    fingerprint: {
      state: c.fingerprint.state,
      truncated: c.fingerprint.truncated,
      manifest_hash: c.checkpoint?.diff_fingerprint_summary.manifest_hash ?? null,
    },
    overlap: c.overlap,
    association: c.association,
    enrichment: c.enrichment,
    issues: c.issues,
    reachability: match.reachability,
    reachability_basis: match.reachability_basis,
    relationship: match.relationship,
    confidence: match.confidence,
    content_match: match.content_match,
    manifest_files: match.manifest_files,
    provisional: match.provisional,
    reasons: match.reasons,
  };
}

type FilePair = { file_before: string | null; file_after: string | null };
function filePreview(value: FilePair) {
  return {
    file_before: value.file_before === null ? null : textPreview(value.file_before),
    file_after: value.file_after === null ? null : textPreview(value.file_after),
  };
}

export function provenanceTargetFacts(c: DetailedProvenanceCandidate, file: string) {
  const overlap = c.overlap;
  const matchesTarget = (entry: FilePair) =>
    entry.file_before === file || entry.file_after === file;
  return {
    target_unmerged: c.checkpoint?.attribution_degraded?.unmerged_paths.includes(file) ?? false,
    overlap:
      overlap === null
        ? null
        : {
            ambiguous: overlap.ambiguous.some(matchesTarget),
            mixed_segment: overlap.mixedSegment.some(matchesTarget),
            own_claim_pending: overlap.ownClaimPending.some(matchesTarget),
            segment_attributed: overlap.segmentAttributed.includes(file),
            unattributed_in_window: overlap.unattributedInWindow.includes(file),
          },
  };
}

export function compactProvenanceCandidate(
  c: DetailedProvenanceCandidate,
  file: string,
  facts = provenanceTargetFacts(c, file)
) {
  const checkpoint = c.checkpoint;
  const overlap = c.overlap;
  return {
    root_key: c.root_key,
    project_id: c.project_id,
    store_instance_id: c.store_instance_id,
    artifact_id: c.artifact_id,
    locator: c.locator,
    version_token: c.version_token,
    artifact_generation: c.artifact_generation,
    pending: c.pending,
    origin: c.origin,
    kind: c.kind,
    label: c.label,
    source_event_id: c.source_event_id,
    recorded_at: c.recorded_at,
    reachability: c.reachability,
    reachability_basis: c.reachability_basis,
    relationship: c.relationship,
    confidence: c.confidence,
    content_match: c.content_match,
    provisional: c.provisional,
    reasons: c.reasons,
    evidence_counts: {
      plan_decisions: c.plan_support.plan?.decisions.length ?? null,
      checkpoint_decisions: checkpoint?.decisions.length ?? null,
      checkpoint_uncertainty: checkpoint?.uncertainty.length ?? null,
    },
    manifest_files: preview(c.manifest_files, textPreview),
    plan_support: {
      anchor_event_id: c.plan_support.anchor_event_id,
      source_event_id: c.plan_support.source_event_id,
      content_event_id: c.plan_support.content_event_id,
      state: c.plan_support.state,
      base_sha: c.plan_support.plan?.base_sha ?? null,
    },
    source_plan:
      c.source_plan === null
        ? null
        : {
            source_ref: c.source_plan.source_ref,
            hash: c.source_plan.hash,
            baseline: c.source_plan.baseline,
          },
    checkpoint:
      checkpoint === null
        ? null
        : {
            n: checkpoint.n,
            source_event_id: checkpoint.source_event_id,
            source_event_ids: {
              opened: checkpoint.source_event_ids.opened,
              closed: checkpoint.source_event_ids.closed,
            },
            open_plan_revision_event_id: checkpoint.open_plan_revision_event_id,
            head_sha: checkpoint.head_sha,
            open_head_sha: checkpoint.open_head_sha ?? null,
            attribution_degraded:
              checkpoint.attribution_degraded === undefined
                ? null
                : {
                    target_unmerged: facts.target_unmerged,
                    probe_failed: checkpoint.attribution_degraded.probe_failed === true,
                    unmerged_paths: preview(
                      checkpoint.attribution_degraded.unmerged_paths,
                      textPreview
                    ),
                  },
          },
    fingerprint: {
      state: c.fingerprint.state,
      truncated: c.fingerprint.truncated,
      manifest_hash: c.fingerprint.manifest_hash,
    },
    overlap:
      overlap === null
        ? null
        : {
            n: overlap.n,
            finalized: overlap.finalized,
            target: facts.overlap,
            ambiguous: preview(overlap.ambiguous, filePreview),
            mixedSegment: preview(overlap.mixedSegment, filePreview),
            ownClaimPending: preview(overlap.ownClaimPending, filePreview),
            dropped: preview(overlap.dropped, (entry) => ({
              ...filePreview(entry),
              status: entry.status,
            })),
            segmentAttributed: preview(overlap.segmentAttributed, textPreview),
            unattributedInWindow: preview(overlap.unattributedInWindow, textPreview),
            unreadableSiblingArtifacts: preview(overlap.unreadableSiblingArtifacts, (id) => id),
          },
    association: {
      worktree_ids: preview(c.association.worktree_ids, (id) => id),
      unknown: c.association.unknown,
      checkpoint_worktree_id: c.association.checkpoint_worktree_id,
    },
    enrichment:
      c.enrichment === null
        ? null
        : {
            content_event_id: c.enrichment.content_event_id,
            enriched_at: c.enrichment.enriched_at,
            plan_available: c.enrichment.plan !== null,
            checkpoint_summary_available: c.enrichment.checkpoint_summary !== null,
          },
    issues: compactProvenanceIssues(c.issues),
  };
}

export type CompactProvenanceCandidate = ReturnType<typeof compactProvenanceCandidate>;
