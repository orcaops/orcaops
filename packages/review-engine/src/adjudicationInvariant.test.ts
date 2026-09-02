// THE INVARIANT: no heuristic may move a captured claim into an adjudicated
// state.
//
// This test exists because the engine violated it and shipped. `composeStory`
// treated a SUPERSESSION_CANDIDATE ledger row as an "explicit machine link" and
// promoted the cited uncertainty to RECONCILED — while that row is produced by
// token overlap >= 0.5 with >= 3 shared tokens, and claimLedger's own header
// says CANDIDATE status exists *precisely because a human confirms*. The single
// live match was a false positive: an eligibility question paired with an
// unrelated latency measurement because both contained timing words.
//
// The rule the engine now obeys:
//
//   The engine may assert structural and directly measured facts. Anything
//   requiring semantic interpretation stays unadjudicated, or is authored
//   explicitly by the LLM following the skill.
//
// So this file asserts the *absence of a capability*, not the presence of one.
// It is deliberately written against the widest input a caller can supply: a
// ledger carrying every kind the engine can emit, each row citing a real
// uncertainty and anchoring a real Part. If any future heuristic learns to
// resolve, fold, or reconcile a captured claim, one of these fails.

import { describe, expect, it } from 'vitest';

import { buildReviewFloorFixture, CITATION_KIND } from '@orcaops/review-core';

import { buildClaimLedger, CLAIM_LEDGER_ENTRY_KIND, DUPLICATE_SCAN_CAP } from './claimLedger.js';
import type { AccountProjection, DossierV1, ProjectionLedgerEntry } from './dossier.js';
import { composeStory } from './twolaneSlice.js';
import type { AccountPayload, UncertaintyState } from './twolaneSlice.js';

/**
 * Kinds that assert a *relation between claims* rather than a measured fact.
 * A ledger kind may describe evidence; it may never describe a resolution.
 * Membership here is the bug, so the list is expressed as forbidden substrings
 * rather than exact names — a `SUPERSESSION_CANDIDATE_V2` must fail too.
 */
const ADJUDICATING_NAME_FRAGMENTS = [
  'SUPERSESS',
  'RECONCIL',
  'RESOLVE',
  'RESOLVED',
  'OBSOLETE',
  'SUPERCEDE',
];

/**
 * States that claim a captured question has been *settled*. The invariant is
 * that none is reachable from a heuristic — asserted against the set rather
 * than against one spelling, so a rename cannot quietly restore the capability.
 */
const ADJUDICATED_STATES = ['RECONCILED', 'RESOLVED', 'ACKNOWLEDGED', 'SUPERSEDED'];

const UNCERTAINTY_ID = 'cite:a1:cp1:uncertainty:0';
const AUTHORITY_ID = 'cite:a1:cp2:decision:0';
const REF = 'a1:cp1';

const ledgerRow = (
  over: Partial<ProjectionLedgerEntry> & Pick<ProjectionLedgerEntry, 'id' | 'kind'>
): ProjectionLedgerEntry => ({
  status: 'CANDIDATE',
  message: 'm',
  // Every row cites the uncertainty AND names a later authority — the exact
  // shape the deleted promotion keyed on. If any rule reads this as a link,
  // it shows up as an adjudicated state below.
  citations: [UNCERTAINTY_ID, AUTHORITY_ID],
  anchors: [REF],
  citedFallback: {},
  ...over,
});

/** A ledger carrying one row of EVERY kind the engine can emit. */
const everyKindLedger = (): ProjectionLedgerEntry[] =>
  Object.values(CLAIM_LEDGER_ENTRY_KIND).map((kind, i) =>
    ledgerRow({ id: `ldg:${kind}:${String(i)}`, kind })
  );

const projectionWithUncertainty = (ledger: ProjectionLedgerEntry[]): AccountProjection =>
  ({
    schema_version: 1,
    branch: 'invariant-branch',
    floor_input_hash: 'f'.repeat(16),
    artifactAliases: { a1: 'a1' },
    accountCore: {
      checkpoints: [
        {
          artifact: 'a1',
          cp: 1,
          status: 'closed' as const,
          label: null,
          summary: null,
          decisions: [],
          uncertainty: [{ citationId: UNCERTAINTY_ID, text: 'Is the ceiling still 2000 ms?' }],
        },
        {
          artifact: 'a1',
          cp: 2,
          status: 'closed' as const,
          label: null,
          summary: null,
          decisions: [
            {
              citationId: AUTHORITY_ID,
              text: 'Tightened the ceiling from 2000 ms to 1500 ms.',
              alternatives: [],
            },
          ],
          uncertainty: [],
        },
      ],
      planSteps: [],
      nonGoals: [],
      planDecisions: [],
      acceptanceCriteria: [],
      criterionEvidence: [],
      verification: [],
      evaluatorRuns: [],
      ledger,
    },
    implicatedHunks: [],
    riskRemainder: [],
    fileInventory: [],
    inventoryMode: 'full',
    manifestSummary: { counts: {}, topOmittedHunks: [] },
  }) as unknown as AccountProjection;

const story = (): AccountPayload => ({
  overview: { text: '', citations: [] },
  acts: [{ id: 'A1', title: 'Invariant' }],
  parts: [
    {
      id: 'P1',
      title: 'Invariant claims',
      act: 'A1',
      checkpoint_refs: ['a1:cp1', 'a1:cp2'],
      interpretation: 'P1 did its work.',
      citations: [UNCERTAINTY_ID],
    },
  ],
  questions: [],
});

const dossier = (): DossierV1 =>
  ({
    schema_version: 1,
    branch: 'invariant-branch',
    floor_input_hash: 'f'.repeat(16),
    file_index: [],
  }) as unknown as DossierV1;

const compose = (ledger: ProjectionLedgerEntry[]) =>
  composeStory({
    account: story(),
    forensic: null,
    projection: projectionWithUncertainty(ledger),
    dossier: dossier(),
    // Attribution unusable — irrelevant to adjudication, and it keeps the
    // fixture free of a coverage corpus this invariant does not depend on.
    coverage: null,
  });

describe('INVARIANT: no heuristic adjudicates a captured claim', () => {
  it('the uncertainty state is a SINGLE-member union, enforced by the compiler', () => {
    // The runtime assertions below can only sample the inputs a test thinks to
    // build. This one holds for every input there will ever be: if the union
    // ever gains a second member, `UncertaintyState['state']` stops being
    // assignable to the literal and this file fails to compile.
    const onlyMember: UncertaintyState['state'] = 'UNADJUDICATED';
    const proof: 'UNADJUDICATED' = onlyMember;
    expect(proof).toBe('UNADJUDICATED');
  });

  it('no ledger kind names a resolution relation', () => {
    for (const kind of Object.values(CLAIM_LEDGER_ENTRY_KIND)) {
      for (const fragment of ADJUDICATING_NAME_FRAGMENTS) {
        expect(
          kind.toUpperCase().includes(fragment),
          `ledger kind ${kind} names a resolution relation (${fragment}); a deterministic rule may report evidence, never a verdict`
        ).toBe(false);
      }
    }
  });

  it('every captured uncertainty stays unadjudicated, whatever the ledger says', () => {
    const composed = compose(everyKindLedger());
    expect(composed.uncertainties).toHaveLength(1);
    for (const u of composed.uncertainties) {
      expect(
        ADJUDICATED_STATES.includes(u.state),
        `uncertainty ${u.citationId} was adjudicated to ${u.state} by a ledger heuristic`
      ).toBe(false);
    }
  });

  it('no ledger row is dispositioned as reconciled', () => {
    const composed = compose(everyKindLedger());
    expect(composed.ledger.length).toBeGreaterThan(0);
    for (const row of composed.ledger) {
      expect(
        row.disposition,
        `ledger row ${row.id} (${row.kind}) claims a RECONCILED disposition`
      ).not.toBe('RECONCILED');
    }
  });

  it('holds for an unknown future kind that cites an uncertainty and a later authority', () => {
    // The promotion keyed on `row.kind === 'SUPERSESSION_CANDIDATE'`. A rename
    // would have slipped straight past a test that only pinned that string, so
    // the invariant is asserted over an arbitrary kind with the same shape.
    const composed = compose([
      ledgerRow({ id: 'ldg:FUTURE_KIND:0', kind: 'FUTURE_KIND' as never }),
    ]);
    expect(ADJUDICATED_STATES).not.toContain(composed.uncertainties[0]!.state);
    expect(composed.ledger[0]!.disposition).not.toBe('RECONCILED');
  });
});

// ---------------------------------------------------------------------------
// The same invariant, at the level of PROSE.
//
// The kinds above were renamed to read as leads rather than verdicts, and the
// messages were left behind still stating the verdicts. The engine then
// emitted, off five shared tokens:
//
//   "Two captured uncertainties describe the same condition (5 shared terms)"
//
// A reviewer reads the message, not the kind. So the rule the engine obeys —
// report evidence, never a verdict — has to bind the sentence too, or the
// rename was cosmetic.
// ---------------------------------------------------------------------------

/**
 * Phrases that state a conclusion no deterministic rule in this file can reach:
 * that two texts MEAN the same thing, or that a file IS junk. Asserted over
 * every emitted message rather than the two kinds that regressed, because the
 * rule is general and the next overclaim will not be in today's kind.
 */
const OVERCLAIMING_PHRASES = [
  'describe the same condition',
  'are the same',
  'the same issue',
  'duplicate of',
  'litter',
  'junk',
  'stray',
];

/** Letters-only, unique per n, so no two generated texts share a token. */
const uniqueWord = (n: number): string => {
  let s = '';
  let x = n;
  do {
    s = String.fromCharCode(97 + (x % 26)) + s;
    x = Math.floor(x / 26);
  } while (x > 0);
  return `zz${s}`;
};

const AT = '2026-07-20T00:00:00.000Z';
const ledgerOf = (floor: Parameters<typeof buildClaimLedger>[0]['floor']) =>
  buildClaimLedger({ floor, checkpoints: [], generatedAt: AT }).entries;

/** A near-duplicate pair, which is the only way to get a CANDIDATE duplicate row. */
function duplicatePairFloor() {
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
  return fixture.floor;
}

/** Enough mutually-disjoint uncertainties to trip the pairwise scan cap. */
function scanCapFloor() {
  const fixture = buildReviewFloorFixture('clean');
  for (let i = 0; i <= DUPLICATE_SCAN_CAP; i += 1) {
    fixture.floor.citations.push({
      id: `cite:artifact-fixture:cp1:uncertainty:gen-${String(i)}`,
      kind: CITATION_KIND.CHECKPOINT_UNCERTAINTY,
      artifact: 'artifact-fixture',
      cp: 1,
      // Six words unique to this item, so nothing pairs and the ONLY duplicate
      // row emitted is the scan-cap disclosure under test.
      text: Array.from({ length: 6 }, (_, k) => uniqueWord(i * 6 + k)).join(' '),
    });
  }
  return fixture.floor;
}

function untrackedFloor() {
  const fixture = buildReviewFloorFixture('clean');
  fixture.floor.disclosure.push({
    code: 'untracked_evidence_excluded',
    message: 'untracked files excluded from review scope: scratch/notes.md',
  });
  return fixture.floor;
}

describe('INVARIANT: a ledger message reports evidence, never a verdict', () => {
  it('no emitted message asserts a conclusion the rule cannot measure', () => {
    // Deliberately across ALL kinds and all three fixtures — the rule is not
    // about the two messages that regressed.
    for (const floor of [duplicatePairFloor(), scanCapFloor(), untrackedFloor()]) {
      for (const entry of ledgerOf(floor)) {
        for (const phrase of OVERCLAIMING_PHRASES) {
          expect(
            entry.message.toLowerCase().includes(phrase),
            `ledger ${entry.kind} message asserts "${phrase}", which is a verdict: ${entry.message}`
          ).toBe(false);
        }
      }
    }
  });

  it('a CANDIDATE duplicate row cites the overlap it actually measured', () => {
    // The positive half. A forbidden-phrase list alone loses to a rename — an
    // overclaim spelled differently still passes it. Requiring the measurement
    // in the sentence is what makes the message answerable.
    const candidates = ledgerOf(duplicatePairFloor()).filter(
      (e) => e.kind === CLAIM_LEDGER_ENTRY_KIND.POSSIBLE_TEXT_DUPLICATE && e.status === 'CANDIDATE'
    );
    expect(candidates).toHaveLength(1);
    const row = candidates[0]!;
    const shared = (row.evidence.sharedTokens as string[]).length;
    expect(row.message).toContain(String(shared));
    expect(row.message.toLowerCase()).toContain('containment');
    // States what overlap does NOT license, in the sentence itself.
    expect(row.message.toLowerCase()).toContain('cannot tell');
  });

  it('an INCONCLUSIVE scan-cap row reports only the cap and the population it skipped', () => {
    // This row has NO overlap to cite — it exists precisely because pairs were
    // not compared. A blanket "every duplicate message cites its overlap" rule
    // would fail the one row in this kind that was already exemplary, which is
    // why the two forms are asserted separately.
    const capRows = ledgerOf(scanCapFloor()).filter(
      (e) =>
        e.kind === CLAIM_LEDGER_ENTRY_KIND.POSSIBLE_TEXT_DUPLICATE && e.status === 'INCONCLUSIVE'
    );
    expect(capRows).toHaveLength(1);
    const row = capRows[0]!;
    expect(row.message).toContain(String(DUPLICATE_SCAN_CAP));
    expect(row.message).toContain(String(row.evidence.total));
    expect(row.message.toLowerCase()).toContain('not compared');
    expect(row.evidence.containment).toBeUndefined();
    expect(row.citations).toEqual([]);
  });

  it('an untracked-evidence row states the measurement and leaves the judgement open', () => {
    const rows = ledgerOf(untrackedFloor()).filter(
      (e) => e.kind === CLAIM_LEDGER_ENTRY_KIND.UNTRACKED_EVIDENCE
    );
    expect(rows).toHaveLength(1);
    const message = rows[0]!.message.toLowerCase();
    // The three things the floor genuinely measured.
    expect(message).toContain('untracked');
    expect(message).toContain('outside review scope');
    // And an explicit statement that intent is not among them.
    expect(message).toContain('not something the floor can determine');
  });
});
