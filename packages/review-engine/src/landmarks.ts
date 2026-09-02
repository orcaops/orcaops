// Structural landmarks — the deterministic "look here" signals derived from the
// coverage result + capture metadata. No LLM: every landmark is a fact the
// floor can assert.

import {
  COVERAGE_VERDICT,
  type CoverageItem,
  LANDMARK,
  type LandmarkEntry,
} from '@orcaops/review-core';

import { orderedCheckpoints, type ReviewArtifact } from './model.js';

export function buildLandmarks(
  artifacts: readonly ReviewArtifact[],
  coverageItems: readonly CoverageItem[]
): LandmarkEntry[] {
  const landmarks: LandmarkEntry[] = [];

  const threadCount = artifacts.filter((a) => orderedCheckpoints(a).length > 0).length;
  if (threadCount > 1) {
    landmarks.push({
      kind: LANDMARK.CROSS_THREAD,
      text: `${threadCount} threads active on this branch`,
    });
  }

  for (const a of artifacts) {
    if (a.planRevisions > 0) {
      landmarks.push({
        kind: LANDMARK.PLAN_REVISION,
        text: `plan revised ${a.planRevisions}×`,
        ref: { artifact: a.id },
      });
    }
  }

  // UNEXPLAINED = zero checkpoint-owned slices in the whole hunk (all-gap /
  // unowned / ambiguous) — the parents whose work no checkpoint accounts for.
  const unexplained = coverageItems.filter(
    (i) => i.verdict === COVERAGE_VERDICT.UNEXPLAINED
  ).length;
  if (unexplained > 0) {
    landmarks.push({
      kind: LANDMARK.OFF_PLAN,
      text: `${unexplained} hunk(s) with no checkpoint-owned work`,
    });
  }

  // Slice grain: a hunk is "mixed" when its unit set carries more than one
  // distinct owner IDENTITY — checkpoint refs, gap segments, and `unowned`
  // each count once (a same-owner delete/add pair is one identity, never two).
  const mixed = coverageItems.filter((item) => {
    const identities = new Set<string>();
    for (const unit of item.units) {
      if (unit.kind === 'owned_slice') {
        identities.add(`cp:${unit.owner.artifact}:${unit.owner.cp}`);
      } else if (unit.kind === 'gap_slice') {
        identities.add(unit.owner === null ? 'unowned' : `gap:${unit.owner.segment}`);
      }
    }
    return identities.size > 1;
  }).length;
  if (mixed > 0) {
    landmarks.push({
      kind: LANDMARK.LATER_TOUCH,
      text: `${mixed} hunk(s) contain work from more than one checkpoint/gap`,
    });
  }

  return landmarks;
}
