import type { ProvenanceCandidate, ProvenanceCandidates } from './provenance-candidates.js';
import type {
  ProvenanceReachability,
  ProvenanceRepository,
  ProvenanceTarget,
} from './provenance-target.js';
import { TRIVIAL_LINE_MIN_BYTES } from '../attribution/line-match.js';
import { lineHash, normalizeLineBody } from '../diff-fingerprint/adapter.js';

export interface ProvenanceMatch {
  candidate: ProvenanceCandidate;
  reachability: ProvenanceReachability;
  reachability_basis: 'checkpoint_head' | 'plan_base';
  relationship: 'reachable_history' | 'rewrite_evidence' | 'related_history' | 'unknown';
  confidence: 'exact' | 'likely' | 'weak';
  content_match: 'same_file' | 'cross_file' | 'none' | 'trivial' | 'unavailable';
  manifest_files: string[];
  provisional: boolean;
  reasons: string[];
}

export interface ProvenanceResolution {
  target: ProvenanceTarget;
  best: ProvenanceMatch | null;
  matches: ProvenanceMatch[];
  conclusion: 'supported' | 'related_history' | 'ambiguous' | 'none';
  uncertainty: string[];
  source_versions: ProvenanceCandidates['source_versions'];
  completeness: ProvenanceCandidates['completeness'];
}

const FILE_LINE_LIMIT = 4096;

const pathMatches = (
  entry: { file_before: string | null; file_after: string | null },
  file: string
) => entry.file_before === file || entry.file_after === file;

export async function resolveProvenance(input: {
  target: ProvenanceTarget;
  sources: ProvenanceCandidates;
  repository: Pick<ProvenanceRepository, 'reachability'>;
}): Promise<ProvenanceResolution> {
  const { target, sources, repository } = input;
  const relationships = new Map<string, Promise<ProvenanceReachability>>();
  const reachable = (
    ancestor: string | null | undefined,
    descendant: string | null | undefined
  ) => {
    if (!ancestor || !descendant) return Promise.resolve('unknown' as const);
    const key = `${ancestor}\0${descendant}`;
    let result = relationships.get(key);
    if (!result) {
      result = repository.reachability(ancestor, descendant).catch(() => 'unknown' as const);
      relationships.set(key, result);
    }
    return result;
  };
  const lineBytes =
    target.line_content === null ? null : new TextEncoder().encode(target.line_content);
  const normalizedLine = lineBytes === null ? null : Buffer.from(normalizeLineBody(lineBytes));
  const trivial = normalizedLine !== null && normalizedLine.length < TRIVIAL_LINE_MIN_BYTES;
  const hash = lineBytes !== null && !trivial ? await lineHash('add', lineBytes) : null;
  const repeated =
    target.line_content !== null &&
    target.content !== null &&
    target.content
      .split('\n')
      .filter((line) =>
        Buffer.from(normalizeLineBody(new TextEncoder().encode(line))).equals(normalizedLine!)
      ).length > 1;
  const fileHashes = new Set<string>();
  let fileEvidenceOmitted = false;
  if (target.line === null && target.content !== null) {
    const lines = target.content.split('\n');
    const counts = new Map<string, number>();
    for (const line of lines) {
      const normalized = Buffer.from(normalizeLineBody(new TextEncoder().encode(line))).toString(
        'utf8'
      );
      counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
    }
    let sampled = 0;
    for (const [line, count] of counts) {
      const bytes = Buffer.from(line);
      if (count !== 1 || bytes.length < TRIVIAL_LINE_MIN_BYTES) continue;
      if (sampled === FILE_LINE_LIMIT) {
        fileEvidenceOmitted = true;
        break;
      }
      sampled++;
      fileHashes.add(await lineHash('add', bytes));
    }
  }
  const checkpointArtifacts = new Set(
    sources.candidates
      .filter((candidate) => candidate.checkpoint !== null)
      .map((candidate) => candidate.artifact_id)
  );
  const fileArtifacts = new Set(
    sources.candidates
      .filter(
        (candidate) =>
          candidate.checkpoint?.files_changed.includes(target.file) ||
          candidate.fingerprint.manifest?.hunks.some((hunk) => pathMatches(hunk, target.file))
      )
      .map((candidate) => candidate.artifact_id)
  );
  const matches: ProvenanceMatch[] = [];
  for (const candidate of sources.candidates) {
    const checkpoint = candidate.checkpoint;
    const hunks = candidate.fingerprint.manifest?.hunks ?? [];
    const matching =
      target.line === null
        ? hunks.filter(
            (hunk) =>
              hunk.file_after === target.file &&
              hunk.added_line_hashes.some((value) => fileHashes.has(value))
          )
        : hash === null
          ? []
          : hunks.filter((hunk) => hunk.added_line_hashes.includes(hash));
    const sameFile = matching.filter((hunk) => hunk.file_after === target.file);
    const claimed = checkpoint?.files_changed.includes(target.file) ?? false;
    const recordedPath = hunks.some((hunk) => pathMatches(hunk, target.file));
    const planned =
      candidate.kind === 'plan' &&
      (!checkpointArtifacts.has(candidate.artifact_id) || fileArtifacts.has(candidate.artifact_id));
    if (!claimed && !recordedPath && !matching.length && !planned) continue;
    const reachability = await reachable(
      checkpoint?.head_sha ?? candidate.plan_support.plan?.base_sha,
      target.commit_sha
    );
    const match: ProvenanceMatch = {
      candidate,
      reachability,
      reachability_basis: checkpoint ? 'checkpoint_head' : 'plan_base',
      relationship:
        reachability === 'reachable'
          ? 'reachable_history'
          : reachability === 'unreachable' &&
              sameFile.length &&
              !sameFile.some((hunk) => hunk.change_type === 'copy')
            ? 'rewrite_evidence'
            : reachability === 'unknown'
              ? 'unknown'
              : 'related_history',
      confidence: 'weak',
      content_match:
        target.line === null
          ? sameFile.length
            ? 'same_file'
            : 'none'
          : trivial
            ? 'trivial'
            : hash === null
              ? 'unavailable'
              : sameFile.length
                ? 'same_file'
                : matching.length
                  ? 'cross_file'
                  : 'none',
      manifest_files: [
        ...new Set(matching.flatMap((hunk) => hunk.file_after ?? hunk.file_before ?? [])),
      ].sort(),
      provisional: false,
      reasons: [],
    };
    if (target.line === null) {
      match.reasons.push(
        checkpoint
          ? 'Recorded file history; no line authorship is asserted'
          : 'Project plan context; no completed file change is asserted'
      );
      if (sameFile.length)
        match.reasons.push(
          'Nontrivial unique file content survives from original same-file fingerprints; whole-file authorship remains unproven'
        );
    } else if (sameFile.length && !sameFile.some((hunk) => hunk.change_type === 'copy')) {
      match.confidence = 'exact';
      match.reasons.push(
        'Selected nontrivial line content matches the original same-file added-line fingerprint'
      );
    } else if (matching.length) {
      match.reasons.push(
        'Matching content was copied or recorded under another path; authorship is unproven'
      );
    } else if (checkpoint && target.blame.status === 'committed') {
      const blame = target.blame.sha;
      const start = checkpoint.open_head_sha ?? candidate.plan_support.plan?.base_sha;
      const authoredAfterOpen =
        (await reachable(start, blame)) === 'reachable' &&
        (await reachable(blame, start)) === 'unreachable';
      const blameAtHead = await reachable(checkpoint.head_sha, blame);
      if (checkpoint.head_sha === blame && blameAtHead === 'reachable' && authoredAfterOpen) {
        match.confidence = 'exact';
        match.reasons.push('Verified checkpoint head is the selected line blame commit');
      } else {
        if ((await reachable(blame, checkpoint.head_sha)) === 'reachable' && authoredAfterOpen) {
          match.confidence = 'likely';
          match.reasons.push(
            'Verified line blame lies inside the recorded checkpoint work interval'
          );
        } else
          match.reasons.push(
            'The recorded file claim does not establish authorship of the selected line'
          );
      }
    } else
      match.reasons.push(
        planned
          ? 'Project plan context does not establish line authorship'
          : 'No committed blame or meaningful fingerprint connects this record to the selected line'
      );

    if (reachability === 'unreachable')
      match.reasons.push(
        'The checkpoint head or plan base is not an ancestor of the selected revision'
      );
    if (reachability === 'unknown')
      match.reasons.push('Missing or unavailable Git evidence leaves reachability unknown');
    const ambiguous = candidate.overlap?.ambiguous.some((entry) => pathMatches(entry, target.file));
    const mixed = candidate.overlap?.mixedSegment.some((entry) => pathMatches(entry, target.file));
    const pending =
      candidate.overlap?.ownClaimPending.some((entry) => pathMatches(entry, target.file)) ||
      (candidate.overlap !== null && !candidate.overlap.finalized);
    const degraded = checkpoint?.attribution_degraded;
    const cautions: string[] = [];
    if (trivial) cautions.push('Trivial line content cannot establish authorship');
    if (repeated) cautions.push('Repeated selected content has no unique line attribution');
    if (target.line !== null && target.blame.status === 'uncommitted')
      cautions.push('The selected line is an uncommitted local edit');
    if (target.state !== 'available' || (target.line !== null && target.line_content === null))
      cautions.push('Selected code content is unavailable');
    if (ambiguous || mixed)
      cautions.push('Overlapping checkpoint claims make attribution ambiguous');
    if (degraded?.unmerged_paths.includes(target.file) || degraded?.probe_failed)
      cautions.push('Checkpoint boundary attribution is degraded');
    if (candidate.plan_support.state === 'unavailable')
      cautions.push('Original checkpoint-open rationale is unavailable');
    if (candidate.fingerprint.state === 'unavailable')
      cautions.push('Recorded fingerprint evidence is unavailable');
    if (cautions.length) {
      match.confidence = 'weak';
      match.reasons.push(...cautions);
    }
    if (pending) {
      match.provisional = true;
      match.reasons.push('Recorded overlap ownership remains provisional');
    }
    if (candidate.fingerprint.truncated)
      match.reasons.push('The original fingerprint manifest is truncated');
    matches.push(match);
  }
  const confidence = { exact: 0, likely: 1, weak: 2 };
  const ancestry = { reachable: 0, unknown: 1, unreachable: 2 };
  const rank = (match: ProvenanceMatch) =>
    target.line === null
      ? [ancestry[match.reachability], Number(match.candidate.kind === 'plan')]
      : [
          confidence[match.confidence],
          Number(match.provisional),
          Number(match.content_match === 'cross_file'),
          ancestry[match.reachability],
          Number(match.candidate.kind === 'plan'),
        ];
  const compare = (a: ProvenanceMatch, b: ProvenanceMatch) => {
    const left = rank(a);
    const right = rank(b);
    for (let i = 0; i < left.length; i++) if (left[i] !== right[i]) return left[i] - right[i];
    return 0;
  };
  matches.sort(
    (a, b) =>
      compare(a, b) ||
      Number(a.candidate.origin === 'imported') - Number(b.candidate.origin === 'imported') ||
      a.candidate.locator.localeCompare(b.candidate.locator)
  );
  const leading = matches[0] ?? null;
  const tied =
    leading !== null && matches.some((match, index) => index > 0 && compare(leading, match) === 0);
  const supported =
    target.line !== null &&
    leading !== null &&
    leading.confidence !== 'weak' &&
    !leading.provisional &&
    !tied &&
    sources.completeness.complete;
  const uncertainty = [...target.issues];
  if (fileEvidenceOmitted)
    uncertainty.push(
      `Whole-file content evidence is limited to ${FILE_LINE_LIMIT} nontrivial unique lines`
    );
  if (target.line === null && matches.length)
    uncertainty.push(
      'Reachable recorded history does not establish that every design decision remains applicable'
    );
  if (tied)
    uncertainty.push(
      'Multiple candidates have comparable applicability; recording time does not decide which rationale applies'
    );
  if (!sources.completeness.complete)
    uncertainty.push('Canonical provenance sources or their supporting evidence are incomplete');
  if (matches.length && !supported)
    uncertainty.push('Related reasoning is retained without a definitive current-rationale claim');
  return structuredClone({
    target,
    best: tied ? null : leading,
    matches,
    conclusion: tied
      ? 'ambiguous'
      : supported
        ? 'supported'
        : matches.length
          ? 'related_history'
          : 'none',
    uncertainty,
    source_versions: sources.source_versions,
    completeness: sources.completeness,
  });
}
