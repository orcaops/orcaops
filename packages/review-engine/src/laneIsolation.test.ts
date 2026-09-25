// What each lane's runner is actually handed, and what it is not.
//
// The forensic lane reviews code with no sight of what anybody said they were doing; the account
// lane reviews the account with no sight of the code. Both are served as markdown written to disk
// by `serveLaneEnvelope`, so that string is what these assert on. Asserting on a field a lane never
// reads would prove nothing: a field can stay absent from the object while its text reaches the
// runner through the renderer, and it is the runner's input that the isolation is about.
//
// The continuing knowledge block is capture-derived, so it reaches the account lane and never the
// forensic one; an assessment and an observation reach neither. That is checked two ways:
// byte-identity of the forensic payload when the account lane gains the block or the captures gain
// evidence, and the strict payload schemas, which have no key for an assessment or an observation
// on either side and no key for the block on the forensic one.
import { describe, expect, it } from 'vitest';

import type { KnowledgeBlock } from '@orcaops/core';
import {
  buildReviewFloorFixture,
  CITATION_KIND,
  type Floor,
  formatCitationId,
} from '@orcaops/review-core';

import { buildClaimLedger } from './claimLedger.js';
import {
  accountProjectionSchema,
  buildDossier,
  type BuildDossierInput,
  dossierKnowledge,
  forensicInputSchema,
  PROTECTED_ACCOUNT_FIELDS,
} from './dossier.js';
import { accountRunFacts, type AccountRunFacts, laneMarkdown } from './twolaneRunCli.js';

const AT = '2026-07-19T00:00:00.000Z';
const BRANCH = 'lane-isolation-branch';

/** A marker that only ever appears on one side, so finding it names where it came from. */
const CODE_MARKER = 'MARKER_FROM_THE_WORKING_TREE';
const CAPTURE_MARKER = 'MARKER_FROM_A_CAPTURE';
const ASSESSMENT_MARKER = 'MARKER_FROM_AN_ASSESSMENT';
const KNOWLEDGE_MARKER = 'MARKER_FROM_CONTINUING_KNOWLEDGE';

const BASIS = {
  scope: { kind: 'project', project_id: 'project-1' },
  mode: 'current',
  knowledge_boundary: 42,
} as const;

/** One rule that stands, as the composer shaped it for a surface to render. */
function knowledgeBlock(): KnowledgeBlock {
  return {
    basis: BASIS,
    entries: [
      {
        key: `requirement:${KNOWLEDGE_MARKER}`,
        target: { kind: 'requirement', entity_id: KNOWLEDGE_MARKER },
        placement: 'applicable',
        reason: 'Adopted in the project, and its applicability holds here.',
        governing_revision_ids: [`${KNOWLEDGE_MARKER}-r1`],
        statement: 'The app keeps working with no network.',
        revisions: [
          {
            revision_id: `${KNOWLEDGE_MARKER}-r1`,
            standing: 'adopted',
            applicability: 'applies',
            statement: 'The app keeps working with no network.',
            is_tip: true,
          },
        ],
        selected_with_plan: [],
        connected_later: [],
      },
    ],
    applicable: [`requirement:${KNOWLEDGE_MARKER}`],
    background: [],
    applicable_not_selected: {
      basis: BASIS,
      artifact_id: null,
      plan_event_id: null,
      entries: [],
      limits: [],
      statement: 'No plan is in view for this read.',
    },
    later_annotations: [],
    coverage: { processing: null, statement: 'This answer claims no completeness.' },
    limits: [],
  };
}

const section = (path: string, bodyLines: string[]): string =>
  [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -1,1 +1,${bodyLines.length + 1} @@`,
    ' context',
    ...bodyLines.map((line) => `+${line}`),
  ].join('\n');

const DIFF = [
  section('src/offline.ts', [`export const marker = '${CODE_MARKER}';`, 'export const n = 1;']),
  section('src/other.ts', ['export const other = 2;']),
].join('\n');

/** The floor the fixture gives, plus capture text carrying a marker of its own. */
function capturedFloor(extra: readonly string[] = []): Floor {
  const floor = JSON.parse(JSON.stringify(buildReviewFloorFixture('clean').floor)) as Floor;
  const artifact = floor.citations[0]?.artifact ?? 'artifact-fixture';
  const thread = floor.outline.threads[0];
  if (thread !== undefined)
    thread.checkpoints[0]!.summary = `cp1 close: reworked the offline stage — ${CAPTURE_MARKER}`;
  // A plan step is artifact-scoped, so it reaches `accountCore.planSteps`, which is what the
  // forensic payload must carry none of. A decision citation would leave that list empty.
  floor.citations.push({
    id: formatCitationId({
      kind: CITATION_KIND.PLAN_STEP,
      artifact,
      checkpointN: null,
      index: 90,
    }),
    kind: CITATION_KIND.PLAN_STEP,
    artifact,
    text: `Plan step: keep the offline path working — ${CAPTURE_MARKER}`,
  } as (typeof floor.citations)[number]);
  extra.forEach((text, index) => {
    floor.citations.push({
      id: formatCitationId({
        kind: CITATION_KIND.CHECKPOINT_DECISION,
        artifact,
        checkpointN: 1,
        index: 91 + index,
      }),
      kind: CITATION_KIND.CHECKPOINT_DECISION,
      artifact,
      cp: 1,
      text,
    } as (typeof floor.citations)[number]);
  });
  return floor;
}

function inputOf(floor: Floor): BuildDossierInput {
  return {
    floor,
    retainedDiff: DIFF,
    ledgerEntries: buildClaimLedger({ floor, checkpoints: [], generatedAt: AT }).entries,
    branch: BRANCH,
    baseSha: 'basesha1234',
    generatedAt: AT,
  };
}

const built = (floor: Floor = capturedFloor(), knowledge: KnowledgeBlock | null = null) =>
  buildDossier({
    ...inputOf(floor),
    knowledge: knowledge === null ? null : dossierKnowledge(knowledge),
  });

const RUN = 'run-fixture';

/** The bytes `serveLaneEnvelope` writes for each lane, through the seam it writes them with. */
function served(dossier: ReturnType<typeof buildDossier>): {
  forensic: string;
  account: string;
  facts: AccountRunFacts;
} {
  const inputs = {
    projection: dossier.accountProjection,
    forensicInput: dossier.forensicInput,
  };
  return {
    forensic: laneMarkdown('forensic', RUN, inputs),
    account: laneMarkdown('account', RUN, inputs),
    facts: accountRunFacts(RUN, inputs),
  };
}

describe('the capture-blind forensic lane', () => {
  it('is handed the code and no capture-derived field', () => {
    const dossier = built();
    const { forensic } = served(dossier);

    expect(Object.keys(dossier.forensicInput).sort()).toEqual([
      'baseSha',
      'diff',
      'excludedPaths',
      'metrics',
      'policyStubs',
      'schema_version',
      'unreviewablePaths',
    ]);
    expect(forensic).toContain(CODE_MARKER);
    expect(forensic).not.toContain(CAPTURE_MARKER);
    expect(forensic).not.toContain(BRANCH);
    for (const citation of dossier.dossier.account_core.checkpoints.flatMap((checkpoint) =>
      checkpoint.decisions.map((decision) => decision.citationId)
    ))
      expect(forensic).not.toContain(citation);
    expect(dossier.accountProjection.accountCore.planSteps.length).toBeGreaterThan(0);
    for (const step of dossier.accountProjection.accountCore.planSteps)
      expect(forensic).not.toContain(step.text);
  });

  it('is handed the same bytes when a knowledge answer, an assessment and an observation are captured', () => {
    const plain = served(built()).forensic;

    const withEvidence = served(
      built(
        capturedFloor([
          `Knowledge answer: ${JSON.stringify({
            basis: { knowledge_boundary: 7, software: null },
            applicable: [`requirement:${CAPTURE_MARKER}`],
          })}`,
          `Assessment: ${JSON.stringify({
            assessment_id: ASSESSMENT_MARKER,
            conclusion: 'contradicted',
            implementation: { kind: 'selected', inputs: [{ kind: 'release', identity: '0.2.1' }] },
          })}`,
          `Observation: ${JSON.stringify({
            observation_id: `observation-${CAPTURE_MARKER}`,
            outcome: 'failed',
          })}`,
        ])
      )
    ).forensic;

    expect(withEvidence).toBe(plain);
    expect(withEvidence).not.toContain(ASSESSMENT_MARKER);
  });

  it('has no key for the knowledge block, an assessment or an observation', () => {
    const dossier = built();
    for (const extra of [
      { knowledge: dossierKnowledge(knowledgeBlock()) },
      { assessments: [{ assessment_id: ASSESSMENT_MARKER }] },
      { observations: [] },
    ])
      expect(() => forensicInputSchema.parse({ ...dossier.forensicInput, ...extra })).toThrow();
  });

  it('is handed the same bytes when the account lane receives a knowledge block', () => {
    const withKnowledge = built(capturedFloor(), knowledgeBlock());

    expect(served(withKnowledge).forensic).toBe(served(built()).forensic);
    expect(JSON.stringify(withKnowledge.forensicInput)).not.toContain(KNOWLEDGE_MARKER);
    expect(withKnowledge.accountProjection.knowledge?.entries[0]?.key).toBe(
      `requirement:${KNOWLEDGE_MARKER}`
    );
  });
});

describe('the code-blind account lane', () => {
  it('is handed no code hunk beyond what PROTECTED_ACCOUNT_FIELDS allows', () => {
    const dossier = built();
    const { account } = served(dossier);

    // The projection object carries the heuristic code selections; the renderer serves none of
    // them, which is why this asserts on the served bytes rather than on the object's fields.
    expect(
      dossier.accountProjection.implicatedHunks.length +
        dossier.accountProjection.riskRemainder.length
    ).toBeGreaterThan(0);
    expect(account).not.toContain(CODE_MARKER);
    expect(account).not.toContain('diff --git');
    expect(account).not.toContain('## Implicated code (raw hunks)');
    expect(account).not.toContain('## Risk remainder (raw hunks)');
    expect(account).not.toContain('## Changed-file inventory');
    for (const hunk of [
      ...dossier.accountProjection.implicatedHunks,
      ...dossier.accountProjection.riskRemainder,
    ])
      expect(account).not.toContain(hunk.raw);
    expect(account).toContain(CAPTURE_MARKER);
  });

  it('is handed only counters from the forensic side, never its diff', () => {
    const { account, facts } = served(built());

    expect(Object.keys(facts).sort()).toEqual([
      'baseSha',
      'eligibleDiffBytes',
      'eligibleFiles',
      'excludedFiles',
      'floorInputHash',
      'latencyTier',
      'policyStubFiles',
      'policyStubRows',
      'runId',
      'unreviewableFiles',
    ]);
    for (const value of Object.values(facts))
      expect(typeof value === 'string' ? value : String(value)).not.toContain(CODE_MARKER);
    expect(account).not.toContain(CODE_MARKER);
  });

  it('carries the knowledge block beside the core, and has no key for an assessment or an observation', () => {
    const dossier = built(capturedFloor(), knowledgeBlock());

    expect(accountProjectionSchema.parse(dossier.accountProjection).knowledge?.boundary).toBe(42);
    for (const extra of [
      { assessments: [{ assessment_id: ASSESSMENT_MARKER }] },
      { observations: [] },
      {
        accountCore: {
          ...dossier.accountProjection.accountCore,
          assessments: [{ assessment_id: ASSESSMENT_MARKER }],
        },
      },
    ])
      expect(() =>
        accountProjectionSchema.parse({ ...dossier.accountProjection, ...extra })
      ).toThrow();
  });

  it('classifies every served account field as protected or reducible', () => {
    const dossier = built();
    const keys = Object.keys(dossier.accountProjection.accountCore).sort();
    expect(keys).toEqual([...PROTECTED_ACCOUNT_FIELDS, 'ledger'].sort());
  });
});

describe('an assessment that used both intent and code', () => {
  it('gives each lane its own half of the review and neither the other half', () => {
    const dossier = built(
      capturedFloor([`Assessment ${ASSESSMENT_MARKER} weighed the plan against the code`])
    );
    const { forensic, account } = served(dossier);

    // The intent side is in the captures and the code side is in the diff, so each lane sees its
    // own half and neither sees the other's.
    expect(forensic).toContain(CODE_MARKER);
    expect(forensic).not.toContain(ASSESSMENT_MARKER);
    expect(account).toContain(ASSESSMENT_MARKER);
    expect(account).not.toContain(CODE_MARKER);
  });
});
