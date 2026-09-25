// Which lane receives the continuing knowledge, and which never does.
//
// The block is capture-derived and carries no code, so it belongs to the lane that reads captures.
// The forensic lane is capture-blind: its input must be byte-identical whether or not this store
// holds a single continuing record, or the blindness is a convention rather than a property.
import { describe, expect, it } from 'vitest';

import type { KnowledgeBlock } from '@orcaops/core';
import { buildReviewFloorFixture } from '@orcaops/review-core';

import { buildClaimLedger } from './claimLedger.js';
import {
  accountProjectionSchema,
  buildDossier,
  type BuildDossierInput,
  dossierKnowledge,
  forensicInputSchema,
  PROTECTED_ACCOUNT_FIELDS,
} from './dossier.js';
import { renderAccountRoutineMd } from './twolaneRunCli.js';

const AT = '2026-09-18T00:00:00.000Z';
const DIFF = [
  'diff --git a/src/offline.ts b/src/offline.ts',
  'index 1111111..2222222 100644',
  '--- a/src/offline.ts',
  '+++ b/src/offline.ts',
  '@@ -1,2 +1,3 @@',
  ' const queue = [];',
  '+const retries = 3;',
  '',
].join('\n');

const GOVERNING = 'requirement-offline-r2';

function block(): KnowledgeBlock {
  return {
    basis: {
      scope: { kind: 'project', project_id: 'project-1' },
      mode: 'current',
      knowledge_boundary: 42,
    },
    entries: [
      {
        key: 'requirement:requirement-offline',
        target: { kind: 'requirement', entity_id: 'requirement-offline' },
        placement: 'applicable',
        reason: 'Adopted in the project, and its applicability holds here.',
        governing_revision_ids: [GOVERNING],
        statement: 'The app keeps working with no network.',
        revisions: [
          {
            revision_id: 'requirement-offline-r1',
            standing: 'not_standing',
            applicability: 'applies',
            statement: 'The app keeps working offline.',
            is_tip: false,
          },
          {
            revision_id: GOVERNING,
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
    applicable: ['requirement:requirement-offline'],
    background: [],
    applicable_not_selected: {
      basis: {
        scope: { kind: 'project', project_id: 'project-1' },
        mode: 'current',
        knowledge_boundary: 42,
      },
      artifact_id: null,
      plan_event_id: null,
      entries: [
        {
          key: 'requirement:requirement-offline',
          target: { kind: 'requirement', entity_id: 'requirement-offline' },
          revision_ids: [GOVERNING],
          selected_revision_ids: [],
          statement: 'The app keeps working with no network.',
          reason: 'This plan records no use of it.',
        },
      ],
      limits: [],
      statement: 'No plan is in view for this read.',
    },
    later_annotations: [],
    coverage: { processing: null, statement: 'This answer claims no completeness.' },
    limits: [],
  };
}

function makeInput(overrides: Partial<BuildDossierInput> = {}): BuildDossierInput {
  const floor = buildReviewFloorFixture('clean').floor;
  return {
    floor,
    retainedDiff: DIFF,
    ledgerEntries: buildClaimLedger({ floor, checkpoints: [], generatedAt: AT }).entries,
    branch: 'feature/knowledge-lane',
    baseSha: 'basesha1234',
    generatedAt: AT,
    ...overrides,
  };
}

describe('the lane the continuing knowledge reaches', () => {
  it('retains independent rejected interpretations only in the account lane', () => {
    const source = block();
    source.entries[0]!.rationale = null;
    source.interpretations = [
      {
        route: 'project',
        writeSequence: 40,
        equivalenceStatus: 'rejected',
        rejection: {
          disposition_id: 'rejection',
          interpretation_id: 'interpretation',
          disposition: 'rejected',
          reason: 'The scope is different.',
          decided_by: { identity: 'owner', basis: 'other_assertion' },
          recorded_at: AT,
        },
        interpretation: {
          interpretation_id: 'interpretation',
          source_origin: { source_id: 'source', task: null },
          wording: 'Persist notes before acknowledging them.',
          source_form: 'stated_obligation',
          proposed_record: 'requirement',
          intended_scope: { kind: 'project' },
          rationale: { kind: 'unknown' },
          uncertainties: [{ about: 'equivalence', note: 'Different acknowledgement boundary.' }],
          evidence: [
            {
              source_id: 'source',
              segment_id: 'segment',
              mapping_version: 'mapping',
              mapping_sha256: 'a'.repeat(64),
              prepared_sha256: 'b'.repeat(64),
              prepared_start_utf8: 0,
              prepared_end_utf8: 12,
              original_ranges: [{ start: 0, end: 12 }],
              quote: 'Flush notes.',
              passage_sha256: 'c'.repeat(64),
            },
          ],
          canonical_outcome: {
            kind: 'proposed_equivalence',
            target: {
              kind: 'requirement',
              entity_id: 'requirement-offline',
              revision_id: GOVERNING,
            },
          },
          attributed_to: { kind: 'detector', detector: 'interpreter' },
          recorded_at: AT,
        },
      },
    ];
    const built = buildDossier(makeInput({ knowledge: dossierKnowledge(source) }));
    expect(built.accountProjection.knowledge?.interpretations).toEqual(source.interpretations);
    expect(accountProjectionSchema.parse(built.accountProjection)).toEqual(built.accountProjection);
    expect(built.forensicInput).toEqual(buildDossier(makeInput()).forensicInput);
    const rendered = renderAccountRoutineMd(built.accountProjection);
    expect(built.accountProjection.knowledge?.entries[0]!.rationale).toBeNull();
    expect(rendered).toContain('Reason: unknown (not supplied)');
    expect(rendered).toContain('Persist notes before acknowledging them.');
    expect(rendered).toContain('Flush notes.');
    expect(rendered).toContain('rejected; not an approved merge');
    expect(rendered).toContain('detector interpretation — unapproved');
    expect(built.accountProjection.knowledge?.entries[0]?.governingRevisionIds).toEqual([
      GOVERNING,
    ]);
  });

  it('gives the account lane what stands, and the forensic lane nothing of it', () => {
    const built = buildDossier(makeInput({ knowledge: dossierKnowledge(block()) }));

    expect(built.accountProjection.knowledge?.entries).toEqual([
      expect.objectContaining({
        key: 'requirement:requirement-offline',
        governingRevisionIds: [GOVERNING],
        placement: 'applicable',
      }),
    ]);
    expect(built.accountProjection.knowledge?.boundary).toBe(42);
    expect(JSON.stringify(built.forensicInput)).not.toContain(GOVERNING);
    expect(JSON.stringify(built.forensicInput)).not.toContain('requirement-offline');
  });

  it('leaves the forensic lane byte-identical whether or not the store holds a record', () => {
    const without = buildDossier(makeInput());
    const with_ = buildDossier(makeInput({ knowledge: dossierKnowledge(block()) }));

    expect(JSON.stringify(with_.forensicInput)).toBe(JSON.stringify(without.forensicInput));
    expect(without.accountProjection.knowledge).toBeNull();
    // A bare null reads as "no rule bears on this work"; the sentence says which it is.
    expect(without.accountProjection.knowledgeStatement).toContain(
      'not a statement that no rule bears on this work'
    );
    expect(with_.accountProjection.knowledgeStatement).toBeUndefined();
  });

  it('keeps the block out of the account core, so the protected corpus is unchanged', () => {
    const without = buildDossier(makeInput());
    const with_ = buildDossier(makeInput({ knowledge: dossierKnowledge(block()) }));

    expect(with_.accountProjection.accountCore).toEqual(without.accountProjection.accountCore);
    expect(PROTECTED_ACCOUNT_FIELDS).not.toContain('knowledge');
    // The disk dossier is the floor's own account; the block is a lane input, not a capture.
    expect(JSON.stringify(with_.dossier)).not.toContain(GOVERNING);
  });

  it('round-trips the block through the account projection schema', () => {
    const built = buildDossier(makeInput({ knowledge: dossierKnowledge(block()) }));

    expect(accountProjectionSchema.parse(built.accountProjection)).toEqual(built.accountProjection);
    expect(forensicInputSchema.parse(built.forensicInput)).toEqual(built.forensicInput);
  });

  it('copies the answer rather than re-deciding it', () => {
    const source = block();
    const projected = dossierKnowledge(source);

    expect(projected.entries[0]!.governingRevisionIds).toEqual(
      source.entries[0]!.governing_revision_ids
    );
    expect(projected.entries[0]!.reason).toBe(source.entries[0]!.reason);
    expect(projected.coverage.statement).toBe(source.coverage.statement);
    expect(projected.notSelectedStatement).toBe(source.applicable_not_selected.statement);
    expect(projected.applicableNotSelected).toEqual([
      { key: 'requirement:requirement-offline', revisionIds: [GOVERNING] },
    ]);
  });
});
