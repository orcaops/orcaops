import { describe, expect, it } from 'vitest';

import { buildReviewFloorFixture, CITATION_KIND, type Floor } from '@orcaops/review-core';

import {
  ATTRIBUTION_MISMATCH_SHARED_EXPLANATION,
  buildClaimLedger,
  type CheckpointClaims,
  CLAIM_LEDGER_ENTRY_KIND,
  CLAIM_LEDGER_SHARED_EXPLANATIONS,
  normalizeClaimTokens,
} from './claimLedger.js';

/**
 * Claim ledger v1 coverage. Includes the sibling flip-assertions
 * promised by ledgerTruthFixtures.test.ts: the SAME floor shapes the legacy
 * composition path accepts as a stale/duplicated account are FLAGGED here —
 * deterministically, with citations, zero model calls. The following cases are
 * pinned alongside: subject-required drift, numeric measure equality, rename
 * INCONCLUSIVE, id injectivity, permutation determinism, and the documented
 * boilerplate limitation.
 */

/**
 * A floor that exercises EVERY surviving ledger kind at once. It replaces a
 * fixture seeded for the deleted supersession rule: with that rule gone the old
 * seed produced a single entry, so the determinism test below would have kept
 * passing while comparing almost nothing.
 */
function richFloor() {
  const fixture = buildReviewFloorFixture('clean');
  fixture.floor.scope.artifact_ids.push('artifact-second');
  fixture.floor.citations.push(
    // → POSSIBLE_TEXT_DUPLICATE (the one lexical rule kept)
    {
      id: 'cite:artifact-fixture:cp2:uncertainty:pg-mysql',
      kind: CITATION_KIND.CHECKPOINT_UNCERTAINTY,
      artifact: 'artifact-fixture',
      cp: 2,
      text: 'pg/mysql tests were not executed locally (need Docker); only the libSQL suite ran.',
    },
    {
      id: 'cite:artifact-second:cp3:uncertainty:pg-mysql',
      kind: CITATION_KIND.CHECKPOINT_UNCERTAINTY,
      artifact: 'artifact-second',
      cp: 3,
      text: 'pg.test.ts and mysql.test.ts were not executed locally (they require Docker Postgres/MySQL).',
    }
  );
  // → UNTRACKED_EVIDENCE
  fixture.floor.disclosure.push({
    code: 'untracked_evidence_excluded',
    message:
      'non-ignored untracked files excluded by the tracked-only review policy (1): skills-lock.json (120 bytes; 1 rows)',
  });
  // → CLAIM_CONTRADICTION (integrity), the one measured contradiction
  fixture.floor.integrity.push({ artifact: 'artifact-fixture', cp: 4, verified: false });
  // → COVERAGE_GAP
  fixture.floor.coverage.summary.unexplained_rows = 2;
  return fixture.floor;
}

/** Claims that make the checkpoint-sourced kinds fire over `richFloor()`. */
const richClaims = (): CheckpointClaims[] => [
  // → VERIFICATION_GAP (completion claimed, nothing run)
  {
    artifact: 'artifact-fixture',
    cp: 1,
    status: 'closed',
    completedStepIds: ['s'],
    filesChanged: ['src/legacy.ts'],
    verificationCommands: [],
  },
];

const AT = '2026-07-17T00:00:00.000Z';

function entriesOf(floor: Floor, checkpoints: CheckpointClaims[] = []) {
  return buildClaimLedger({ floor, checkpoints, generatedAt: AT }).entries;
}

describe('claim ledger — possible text duplicates', () => {
  it('groups a near-duplicate uncertainty pair across artifacts', () => {
    const fixture = buildReviewFloorFixture('clean');
    fixture.floor.scope.artifact_ids.push('artifact-second');
    fixture.floor.citations.push(
      {
        id: 'cite:artifact-fixture:cp2:uncertainty:pg-mysql',
        kind: CITATION_KIND.CHECKPOINT_UNCERTAINTY,
        artifact: 'artifact-fixture',
        cp: 2,
        text: 'pg/mysql tests were not executed locally (need Docker); only the libSQL suite ran.',
      },
      {
        id: 'cite:artifact-second:cp3:uncertainty:pg-mysql',
        kind: CITATION_KIND.CHECKPOINT_UNCERTAINTY,
        artifact: 'artifact-second',
        cp: 3,
        text: 'pg.test.ts and mysql.test.ts were not executed locally (they require Docker Postgres/MySQL).',
      }
    );
    const duplicates = entriesOf(fixture.floor).filter(
      (entry) => entry.kind === CLAIM_LEDGER_ENTRY_KIND.POSSIBLE_TEXT_DUPLICATE
    );
    expect(duplicates).toHaveLength(1);
    expect(duplicates[0]!.citations).toEqual([
      'cite:artifact-fixture:cp2:uncertainty:pg-mysql',
      'cite:artifact-second:cp3:uncertainty:pg-mysql',
    ]);
    expect(duplicates[0]!.evidence.sharedTokens).toEqual(
      expect.arrayContaining(['docker', 'executed', 'locally'])
    );
  });

  it('does not group unrelated uncertainties', () => {
    const fixture = buildReviewFloorFixture('clean');
    fixture.floor.citations.push(
      {
        id: 'cite:artifact-fixture:cp1:uncertainty:a',
        kind: CITATION_KIND.CHECKPOINT_UNCERTAINTY,
        artifact: 'artifact-fixture',
        cp: 1,
        text: 'Cache invalidation race remains unresolved under concurrent teardown.',
      },
      {
        id: 'cite:artifact-fixture:cp2:uncertainty:b',
        kind: CITATION_KIND.CHECKPOINT_UNCERTAINTY,
        artifact: 'artifact-fixture',
        cp: 2,
        text: 'The greeting format may require localization for non-English deployments.',
      }
    );
    expect(
      entriesOf(fixture.floor).filter(
        (entry) => entry.kind === CLAIM_LEDGER_ENTRY_KIND.POSSIBLE_TEXT_DUPLICATE
      )
    ).toHaveLength(0);
  });

  it('labels near-boilerplate matches POSSIBLE rather than definitive', () => {
    // These two describe DIFFERENT concerns but share boilerplate phrasing.
    // The rule matches them anyway. That is tolerable ONLY because the row is
    // named a possible duplicate and folds nothing — the same containment
    // scorer, asked to RESOLVE rather than to suggest, is what this artifact
    // deleted. If a future change stops matching them, that is an improvement:
    // update the spec's limitation note and flip this assertion.
    const fixture = buildReviewFloorFixture('clean');
    fixture.floor.citations.push(
      {
        id: 'cite:artifact-fixture:cp1:uncertainty:latency',
        kind: CITATION_KIND.CHECKPOINT_UNCERTAINTY,
        artifact: 'artifact-fixture',
        cp: 1,
        text: 'Production latency remains unverified under load.',
      },
      {
        id: 'cite:artifact-fixture:cp2:uncertainty:security',
        kind: CITATION_KIND.CHECKPOINT_UNCERTAINTY,
        artifact: 'artifact-fixture',
        cp: 2,
        text: 'Production security remains unverified under load.',
      }
    );
    expect(
      entriesOf(fixture.floor).filter(
        (entry) => entry.kind === CLAIM_LEDGER_ENTRY_KIND.POSSIBLE_TEXT_DUPLICATE
      )
    ).toHaveLength(1);
  });
});

describe('claim ledger — untracked evidence and coverage gaps', () => {
  function litterFloor() {
    const fixture = buildReviewFloorFixture('clean');
    fixture.floor.coverage.items.push({
      hunkKey: 'hunk_litter',
      file: 'tooling/.nvmrc',
      verdict: 'UNEXPLAINED',
      old_start: 1,
      new_start: 1,
      added_lines: 1,
      removed_lines: 1,
      units: [
        {
          kind: 'gap_slice',
          slice: 0,
          patch_row_start: 0,
          patch_row_end: 0,
          del_range: { start: 1, end: 1 },
          add_range: { start: 1, end: 1 },
          lines: 1,
          owner: { kind: 'gap', segment: 'artifact-fixture:cp1->end' },
        },
      ],
    });
    fixture.floor.outline.unassigned.gap.files.push({
      file: 'tooling/.nvmrc',
      slice_count: 1,
      added_rows: 1,
      removed_rows: 1,
    });
    fixture.floor.coverage.summary.unexplained_rows = 2;
    fixture.floor.citations.push({
      id: 'cite:artifact-fixture:non_goal:0',
      kind: CITATION_KIND.PLAN_NON_GOAL,
      artifact: 'artifact-fixture',
      text: 'Do not change developer tooling or the nvmrc in this slice.',
    });
    return fixture.floor;
  }

  it('carries the measured coverage gap and does NOT lexically match the non-goal', () => {
    // This fixture is exactly the shape the deleted rule fired on: a non-goal
    // saying "do not change developer tooling or the nvmrc", paired with a
    // changed `tooling/.nvmrc`. It is also the shape that made the rule useless — the
    // match is a token intersection, so it fires identically whether the branch
    // honoured the non-goal or broke it. Judging that is the model's job now.
    const entries = entriesOf(litterFloor());
    expect(
      entries.filter((entry) => entry.citations.includes('cite:artifact-fixture:non_goal:0'))
    ).toEqual([]);
    // The MEASURED signal in the same fixture still fires, undiminished.
    const gaps = entries.filter((entry) => entry.kind === CLAIM_LEDGER_ENTRY_KIND.COVERAGE_GAP);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]!.evidence.unexplainedRows).toBe(2);
    expect(gaps[0]!.anchors).toContain('tooling/.nvmrc');
  });

  it('gives distinct untracked-litter disclosures distinct identities', () => {
    const fixture = buildReviewFloorFixture('clean');
    fixture.floor.disclosure.push(
      {
        code: 'untracked_evidence_excluded',
        message:
          'non-ignored untracked files excluded by the tracked-only review policy (1): skills-lock.json (120 bytes; 1 rows)',
      },
      {
        code: 'untracked_evidence_excluded',
        message:
          'non-ignored untracked files excluded by the tracked-only review policy (1): local-notes.md (48 bytes; 1 rows)',
      }
    );
    const untracked = entriesOf(fixture.floor).filter(
      (entry) => entry.kind === CLAIM_LEDGER_ENTRY_KIND.UNTRACKED_EVIDENCE
    );
    expect(untracked).toHaveLength(2);
    expect(new Set(untracked.map((entry) => entry.id)).size).toBe(2);
    expect(untracked.some((entry) => entry.anchors.includes('skills-lock.json'))).toBe(true);
  });
});

describe('claim ledger — verification gaps, integrity, and attribution mismatch', () => {
  const closedCheckpoint = (over: Partial<CheckpointClaims>): CheckpointClaims => ({
    artifact: 'artifact-fixture',
    cp: 1,
    status: 'closed',
    completedStepIds: [],
    filesChanged: [],
    verificationCommands: [],
    ...over,
  });

  it('flags completion claims and test changes with zero verification', () => {
    const gaps = entriesOf(buildReviewFloorFixture('clean').floor, [
      closedCheckpoint({ cp: 1, completedStepIds: ['step-1'], verificationCommands: [] }),
      closedCheckpoint({ cp: 2, filesChanged: ['src/gate.test.ts'], verificationCommands: [] }),
      closedCheckpoint({
        cp: 3,
        completedStepIds: ['step-2'],
        verificationCommands: ['pnpm test', 'pnpm lint'],
      }),
    ]).filter((entry) => entry.kind === CLAIM_LEDGER_ENTRY_KIND.VERIFICATION_GAP);
    expect(gaps).toHaveLength(2);
    expect(gaps.some((entry) => entry.anchors.includes('artifact-fixture:cp1'))).toBe(true);
    expect(gaps.some((entry) => entry.anchors.includes('src/gate.test.ts'))).toBe(true);
  });

  describe('command-to-test-file linkage', () => {
    // Keep the command list and its derived count consistent so each case
    // exercises linkage semantics rather than failing on incomplete input.
    const withCommands = (
      over: Partial<CheckpointClaims> & { commands: string[] }
    ): CheckpointClaims => {
      const { commands, ...rest } = over;
      return { ...closedCheckpoint(rest), verificationCommands: commands };
    };

    const unlinkedGaps = (checkpoints: CheckpointClaims[]) =>
      entriesOf(buildReviewFloorFixture('clean').floor, checkpoints).filter(
        (entry) =>
          entry.kind === CLAIM_LEDGER_ENTRY_KIND.VERIFICATION_GAP &&
          typeof entry.evidence.unlinkedTestFiles !== 'undefined'
      );

    it('reports the claimed test file no path-scoped command names (one of two linked)', () => {
      const gaps = unlinkedGaps([
        withCommands({
          cp: 4,
          filesChanged: ['src/alpha.test.ts', 'src/beta.test.ts'],
          commands: ['pnpm exec vitest run src/alpha.test.ts'],
        }),
      ]);
      expect(gaps).toHaveLength(1);
      expect(gaps[0]!.evidence.unlinkedTestFiles).toEqual(['src/beta.test.ts']);
      expect(gaps[0]!.status).toBe('CANDIDATE');
    });

    it('reports both claimed test files when the only command names an unrelated test', () => {
      const gaps = unlinkedGaps([
        withCommands({
          cp: 4,
          filesChanged: ['src/alpha.test.ts', 'src/beta.test.ts'],
          commands: ['pnpm exec vitest run src/other.test.ts'],
        }),
      ]);
      expect(gaps).toHaveLength(1);
      expect(gaps[0]!.evidence.unlinkedTestFiles).toEqual([
        'src/alpha.test.ts',
        'src/beta.test.ts',
      ]);
    });

    it('treats a broad command with no test-path token as covering every claimed test', () => {
      const gaps = unlinkedGaps([
        withCommands({
          cp: 4,
          filesChanged: ['src/alpha.test.ts', 'src/beta.test.ts'],
          commands: ['pnpm test'],
        }),
      ]);
      expect(gaps).toHaveLength(0);
    });

    it('one broad command among path-scoped ones suppresses the linkage gap', () => {
      const gaps = unlinkedGaps([
        withCommands({
          cp: 4,
          filesChanged: ['src/alpha.test.ts', 'src/beta.test.ts'],
          commands: ['pnpm exec vitest run src/other.test.ts', 'pnpm test'],
        }),
      ]);
      expect(gaps).toHaveLength(0);
    });

    it('a command naming every claimed test file yields no linkage gap', () => {
      const gaps = unlinkedGaps([
        withCommands({
          cp: 4,
          filesChanged: ['src/alpha.test.ts', 'src/beta.test.ts'],
          commands: ['pnpm exec vitest run src/alpha.test.ts src/beta.test.ts'],
        }),
      ]);
      expect(gaps).toHaveLength(0);
    });
  });

  it('separates in-scope over-claims (CANDIDATE) from unarbitrable claims (INCONCLUSIVE)', () => {
    const fixture = buildReviewFloorFixture('clean');
    // Give cp2 an owned file so it is not facet-exempt, then claim the file
    // cp1 owns (in-scope over-claim) plus a file outside the review scope
    // entirely (rename/revert shape — the floor cannot arbitrate it).
    fixture.floor.coverage.items.push({
      hunkKey: 'hunk_cp2',
      file: 'src/other.ts',
      verdict: 'MATCHED',
      old_start: 1,
      new_start: 1,
      added_lines: 1,
      removed_lines: 0,
      units: [
        {
          kind: 'owned_slice',
          slice: 0,
          patch_row_start: 0,
          patch_row_end: 0,
          del_range: null,
          add_range: { start: 1, end: 1 },
          lines: 1,
          owner: { kind: 'checkpoint', artifact: 'artifact-fixture', cp: 2 },
        },
      ],
    });
    fixture.floor.integrity.push({ artifact: 'artifact-fixture', cp: 3, verified: false });
    const all = entriesOf(fixture.floor, [
      closedCheckpoint({
        cp: 2,
        filesChanged: ['src/other.ts', 'src/fixture.ts', 'src/legacy.ts'],
        verificationCommands: ['pnpm test'],
      }),
    ]);
    // The two files_changed rules are LEADS: a missed snapshot or a rebase
    // explains them as readily as an inaccurate claim, so they no longer share
    // a kind with the one rule here that is actually measured.
    const mismatches = all.filter(
      (entry) => entry.kind === CLAIM_LEDGER_ENTRY_KIND.ATTRIBUTION_MISMATCH_CANDIDATE
    );
    expect(mismatches).toHaveLength(2);
    const overclaim = mismatches.find((entry) => entry.evidence.overclaimedFiles);
    expect(overclaim?.status).toBe('CANDIDATE');
    expect(overclaim?.anchors).toContain('src/fixture.ts');
    expect(overclaim?.message.endsWith(` ${ATTRIBUTION_MISMATCH_SHARED_EXPLANATION}`)).toBe(true);
    expect(
      CLAIM_LEDGER_SHARED_EXPLANATIONS[CLAIM_LEDGER_ENTRY_KIND.ATTRIBUTION_MISMATCH_CANDIDATE]
    ).toBe(ATTRIBUTION_MISMATCH_SHARED_EXPLANATION);
    const unarbitrable = mismatches.find((entry) => entry.evidence.unarbitrableFiles);
    expect(unarbitrable?.status).toBe('INCONCLUSIVE');
    expect(unarbitrable?.anchors).toContain('src/legacy.ts');
    // CLAIM_CONTRADICTION now means exactly one thing: a captured manifest that
    // does not reproduce against the tree. That IS measured, so it keeps the name.
    const contradictions = all.filter(
      (entry) => entry.kind === CLAIM_LEDGER_ENTRY_KIND.CLAIM_CONTRADICTION
    );
    expect(contradictions).toHaveLength(1);
    expect(contradictions[0]!.evidence.integrity).toBe('MISMATCH');
    expect(contradictions[0]!.anchors).toContain('artifact-fixture:cp3');
  });

  it('does not accuse a facet-only checkpoint of over-claiming', () => {
    expect(
      entriesOf(buildReviewFloorFixture('clean').floor, [
        closedCheckpoint({
          cp: 6,
          filesChanged: ['bench/results.txt'],
          verificationCommands: ['pnpm test'],
        }),
      ]).filter((entry) => entry.kind === CLAIM_LEDGER_ENTRY_KIND.ATTRIBUTION_MISMATCH_CANDIDATE)
    ).toHaveLength(0);
  });
});

describe('claim ledger — determinism and cleanliness', () => {
  it('EVERY surviving kind still fires — proven by fixture, not by whatever a live run happens to hit', () => {
    // The question is whether the factual signals survived the deletions.
    // A single live run only exercises the ones its own branch triggers, so it
    // cannot answer that; this fixture can, and does it deterministically.
    const kinds = new Set(entriesOf(richFloor(), richClaims()).map((entry) => entry.kind));
    // Every kind the enum declares — asserted against the enum itself, so a
    // rule added without a fixture, or silently stopping firing, fails here.
    expect([...kinds].sort()).toEqual([...Object.values(CLAIM_LEDGER_ENTRY_KIND)].sort());
  });

  it('entries are byte-identical across runs and input permutations', () => {
    const checkpoints = richClaims();
    const first = buildClaimLedger({ floor: richFloor(), checkpoints, generatedAt: AT });
    const permutedFloor = richFloor();
    permutedFloor.citations.reverse();
    permutedFloor.disclosure.reverse();
    permutedFloor.integrity.reverse();
    const second = buildClaimLedger({
      floor: permutedFloor,
      checkpoints: [...checkpoints].reverse(),
      generatedAt: '2026-12-31T23:59:59.000Z',
    });
    // generated_at is transport metadata; the deterministic artifact is
    // `entries` — identical bytes despite permuted inputs and a different clock.
    expect(JSON.stringify(first.entries)).toBe(JSON.stringify(second.entries));
    // Guards the guard: a determinism proof over one entry proves little, and
    // that is exactly what deleting the supersession seed would have left here.
    expect(first.entries.length).toBeGreaterThanOrEqual(5);
  });

  it('emits nothing on a clean floor with verified checkpoints', () => {
    expect(
      entriesOf(buildReviewFloorFixture('clean').floor, [
        {
          artifact: 'artifact-fixture',
          cp: 1,
          status: 'closed',
          completedStepIds: ['step-1'],
          filesChanged: ['src/fixture.ts'],
          verificationCommands: ['pnpm test'],
        },
      ])
    ).toEqual([]);
  });

  it('normalizes tokens per the spec (compounds decompose to parts)', () => {
    expect([...normalizeClaimTokens('The pg/mysql tests were NOT executed locally!')]).toEqual(
      expect.arrayContaining(['pg', 'mysql', 'test', 'executed', 'locally'])
    );
    expect([...normalizeClaimTokens('pg.test.ts and mysql.test.ts')]).toEqual(
      expect.arrayContaining(['pg', 'test', 'ts', 'mysql'])
    );
  });
});
