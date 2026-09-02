import { CITATION_KIND, type CitationKind, type Floor, type MemberRef } from '@orcaops/review-core';

export interface CapturedTrailRecord {
  id: string;
  kind: CitationKind;
  label: string;
  text: string;
  artifact: string;
  cp: number | null;
  evaluator: NonNullable<Floor['citations'][number]['evaluator']> | null;
}

export interface AutomatedConcern {
  id: string;
  evaluatorRef: string;
  severity: 'info' | 'warn' | 'block' | null;
  status: 'violation' | 'error';
  text: string;
}

export interface CapturedTrailCheckpoint {
  artifact: string;
  cp: number;
  label: string;
  candidateOnly: boolean;
}

export interface CapturedTrailFile {
  file: string;
  added: number;
  removed: number;
  hunkCount: number;
}

export interface CapturedTrailView {
  threadTitles: string[];
  checkpoints: CapturedTrailCheckpoint[];
  /** Verbatim checkpoint-close outcome when this is a checkpoint page. */
  summary: string | null;
  records: CapturedTrailRecord[];
  claimedWork: string[];
  files: CapturedTrailFile[];
  hunkCount: number;
  changedRows: number;
  provenance: 'asserted' | 'candidate' | 'unassigned';
}

const RECORD_LABEL: Readonly<Record<CitationKind, string>> = {
  [CITATION_KIND.CHECKPOINT_DECISION]: 'DECISION',
  [CITATION_KIND.CHECKPOINT_UNCERTAINTY]: 'FLAGGED',
  [CITATION_KIND.CHECKPOINT_ALTERNATIVE]: 'RULED OUT',
  // Checkpoint-scoped, so these two reach the rail through `owned.citationIds`
  // like decisions and uncertainty do.
  [CITATION_KIND.CRITERION_EVIDENCE]: 'EVIDENCE',
  [CITATION_KIND.CHECKPOINT_VERIFICATION]: 'VERIFIED',
  [CITATION_KIND.PLAN_STEP]: 'PLAN STEP',
  [CITATION_KIND.PLAN_NON_GOAL]: 'NON-GOAL',
  // Artifact-scoped: labelled for completeness (this map is exhaustive over
  // CitationKind), but the rail's artifact-scoped clause admits only SUMMARY
  // and EVALUATOR_RUN, so plan decisions do not appear beside a checkpoint.
  [CITATION_KIND.PLAN_DECISION]: 'PLAN DECISION',
  [CITATION_KIND.PLAN_ALTERNATIVE]: 'PLAN RULED OUT',
  [CITATION_KIND.ACCEPTANCE_CRITERION]: 'ACCEPTANCE',
  [CITATION_KIND.SUMMARY]: 'SUMMARY',
  [CITATION_KIND.EVALUATOR_RUN]: 'EVALUATOR RUN',
};

/**
 * Actionable evaluator outcomes for the primary review surface.
 *
 * Evaluator runs are durable provenance, not review guidance. Completed passes,
 * informational runs, skipped runs, and dispositioned blocking violations stay
 * in the floor but do not occupy the rail.
 */
export function automatedConcerns(records: readonly CapturedTrailRecord[]): AutomatedConcern[] {
  return records.flatMap((record): AutomatedConcern[] => {
    if (record.kind !== CITATION_KIND.EVALUATOR_RUN) return [];
    const evaluator = record.evaluator;
    if (evaluator !== null) {
      if (evaluator.run_status === 'error') {
        return [
          {
            id: record.id,
            evaluatorRef: evaluator.evaluator_ref,
            severity: evaluator.severity,
            status: 'error',
            text: evaluator.summary,
          },
        ];
      }
      if (evaluator.run_status !== 'completed' || evaluator.verdict !== 'violation') return [];
      if (
        evaluator.severity === 'block' &&
        evaluator.disposition !== null &&
        evaluator.disposition !== 'unresolved'
      ) {
        return [];
      }
      return [
        {
          id: record.id,
          evaluatorRef: evaluator.evaluator_ref,
          severity: evaluator.severity,
          status: 'violation',
          text: evaluator.summary,
        },
      ];
    }

    return [];
  });
}

function refKey(ref: MemberRef): string {
  return `${ref.artifact}\u0000${ref.cp}`;
}

function uniqueRefs(refs: readonly MemberRef[]): MemberRef[] {
  const seen = new Set<string>();
  return refs.filter((ref) => {
    const key = refKey(ref);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function matchesRef(ref: MemberRef, artifact: string, cp: number): boolean {
  return ref.artifact === artifact && ref.cp === cp;
}

/**
 * Full deterministic evidence for a set of captured checkpoints.
 *
 * This is deliberately NOT a semantic placement model. Asserted checkpoint
 * ownership identifies which captured records exist in the same provenance
 * unit; ambiguous candidates remain labelled as candidates. Neither case says
 * that a decision or uncertainty describes the selected code.
 */
function capturedTrailFor(
  floor: Floor,
  refs: readonly MemberRef[],
  candidateOnly: boolean,
  provenance: CapturedTrailView['provenance']
): CapturedTrailView {
  const refKeys = new Set(refs.map(refKey));
  // The floor checkpoints in scope, each paired with its thread.
  const owners = floor.outline.threads.flatMap((thread) =>
    thread.checkpoints
      .filter((owned) => refKeys.has(refKey(owned.checkpoint)))
      .map((owned) => ({ thread, owned }))
  );
  const resolvedRefs = uniqueRefs([
    ...refs,
    ...owners.map(({ owned }) => ({
      artifact: owned.checkpoint.artifact,
      cp: owned.checkpoint.cp,
    })),
  ]);
  const resolvedRefKeys = new Set(resolvedRefs.map(refKey));
  const artifacts = new Set(resolvedRefs.map((ref) => ref.artifact));
  const citationIds = new Set(owners.flatMap(({ owned }) => owned.citationIds));
  const records = floor.citations
    .filter(
      (citation) =>
        citationIds.has(citation.id) ||
        (citation.cp == null &&
          artifacts.has(citation.artifact) &&
          (citation.kind === CITATION_KIND.SUMMARY ||
            citation.kind === CITATION_KIND.EVALUATOR_RUN))
    )
    .map(
      (citation): CapturedTrailRecord => ({
        id: citation.id,
        kind: citation.kind,
        label: RECORD_LABEL[citation.kind],
        text: citation.text,
        artifact: citation.artifact,
        cp: citation.cp ?? null,
        evaluator: citation.evaluator ?? null,
      })
    );
  const claimedWork = floor.plan_coverage
    .filter((step) => step.claimed_by.some((claimed) => resolvedRefKeys.has(refKey(claimed))))
    .map((step) => step.label || step.text)
    .filter((text) => text.length > 0);
  const hunkKeys = new Set(
    owners.flatMap(({ owned }) => owned.sliceRefs.map((slice) => slice.hunkKey))
  );
  const fileMap = new Map<string, CapturedTrailFile>();
  let changedRows = 0;
  for (const item of floor.coverage.items) {
    if (!hunkKeys.has(item.hunkKey)) continue;
    changedRows += item.added_lines + item.removed_lines;
    const prior = fileMap.get(item.file) ?? {
      file: item.file,
      added: 0,
      removed: 0,
      hunkCount: 0,
    };
    prior.added += item.added_lines;
    prior.removed += item.removed_lines;
    prior.hunkCount += 1;
    fileMap.set(item.file, prior);
  }
  const checkpoints = resolvedRefs.map((ref) => {
    const match = floor.outline.threads
      .flatMap((thread) => thread.checkpoints)
      .find((candidate) => matchesRef(ref, candidate.checkpoint.artifact, candidate.checkpoint.cp));
    return {
      artifact: ref.artifact,
      cp: ref.cp,
      label: match?.checkpoint.label ?? `Checkpoint ${ref.cp}`,
      candidateOnly,
    };
  });
  const summary =
    owners
      .map(({ owned }) => owned.summary)
      .find(
        (candidate): candidate is string => typeof candidate === 'string' && candidate.length > 0
      ) ?? null;
  return {
    threadTitles: [...new Set(owners.map(({ thread }) => thread.title))],
    checkpoints,
    summary,
    records,
    claimedWork: [...new Set(claimedWork)],
    files: [...fileMap.values()].sort((a, b) => a.file.localeCompare(b.file)),
    hunkCount: hunkKeys.size,
    changedRows,
    provenance,
  };
}

/**
 * The full captured record for one CHECKPOINT — the reader's rail.
 *
 * The deterministic lens shows the full captured content: a compact rail makes
 * recorded reasoning inaccessible precisely when no semantic target exists. Volume
 * is controlled by rendering it ONCE PER PAGE — deriving the trail per hunk prints
 * a checkpoint's decisions once for every hunk it touches.
 *
 * Always `asserted`: a page IS a captured checkpoint. There is nothing to infer.
 */
export function capturedTrailForCheckpoint(floor: Floor, member: MemberRef): CapturedTrailView {
  return capturedTrailFor(floor, [member], false, 'asserted');
}
