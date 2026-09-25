import { describe, expect, it } from 'vitest';

import { knowledgeInterpretationId } from '@orcaops/storage';

import { existingKnowledge } from './evaluation/knowledge.js';
import {
  manifestFor,
  proposalOf,
  quoteOf,
  SOURCE_RECORDED_AT,
  statementOf,
} from './fixture.test-support.js';
import { buildReconciliationPlan, candidateTargetForStatement } from './reconciliation.js';
import { validateProposal } from './validation.js';

function planFor(
  manifest: ReturnType<typeof manifestFor>,
  proposal: ReturnType<typeof proposalOf>,
  candidate_state: Parameters<typeof buildReconciliationPlan>[0]['candidate_state'] = []
) {
  const validation = validateProposal({ manifest, answer: proposal });
  expect(validation.outcome).toBe('accepted');
  if (validation.outcome !== 'accepted') throw new Error('expected accepted proposal');
  return buildReconciliationPlan({
    manifest,
    validated: validation.validated,
    source_recorded_at: SOURCE_RECORDED_AT,
    candidate_state,
  });
}

describe('interpretation reconciliation', () => {
  it('retains proposed equivalence independently and publishes no authority or canonical revision', () => {
    const manifest = manifestFor({
      text: 'Show two digits after the decimal point.',
      related: [
        existingKnowledge({
          kind: 'requirement',
          entity_id: 'requirement-precision',
          revision_id: 'requirement-precision-r2',
          text: 'Display measurements to two decimal places.',
        }),
      ],
    });
    const plan = planFor(
      manifest,
      proposalOf(manifest, {
        statements: [
          statementOf({
            manifest,
            wording: 'Show two digits after the decimal point.',
            links: [{ revision_ref: 'k1r1', relation: 'equivalent_to' }],
          }),
        ],
      })
    );

    expect(plan.records).toHaveLength(1);
    expect(plan.records[0]).toMatchObject({
      kind: 'interpretation',
      record: {
        canonical_outcome: {
          kind: 'proposed_equivalence',
          target: {
            kind: 'requirement',
            entity_id: 'requirement-precision',
            revision_id: 'requirement-precision-r2',
          },
        },
      },
    });
    expect(JSON.stringify(plan.records)).not.toMatch(
      /authorization|designation|task_use|relationship/
    );
    expect(plan.expected_state).toEqual([]);
    expect(plan.quality).toMatchObject({
      accepted: { statements: 1, links: 1 },
      held_back: { statements: 0, links: 0 },
    });
  });

  it('materializes an interpretation-backed decision with explicit unknown rationale', () => {
    const manifest = manifestFor({ text: 'Choose SQLite for the local queue.' });
    const plan = planFor(
      manifest,
      proposalOf(manifest, {
        statements: [
          statementOf({
            manifest,
            wording: 'Use SQLite for the local queue.',
            quote: 'Choose SQLite for the local queue.',
            source_form: 'stated_decision',
            proposed_record: 'decision',
          }),
        ],
      })
    );
    const interpretation = plan.records.find((record) => record.kind === 'interpretation');
    const decision = plan.records.find((record) => record.kind === 'decision_revision');
    expect(interpretation).toMatchObject({
      kind: 'interpretation',
      record: { rationale: { kind: 'unknown' }, canonical_outcome: { kind: 'candidate_revision' } },
    });
    expect(decision).toMatchObject({
      kind: 'decision_revision',
      record: {
        rationale: null,
        passages: [{ location: expect.stringMatching(/^prepared-bytes:/u) }],
        source_standing: 'extracted_candidate',
      },
    });
    if (interpretation?.kind === 'interpretation' && decision?.kind === 'decision_revision') {
      const { interpretation_id, recorded_at, ...identity } = interpretation.record;
      void recorded_at;
      expect(interpretation_id).toBe(
        knowledgeInterpretationId(manifest.processor_contract, identity)
      );
      expect(decision.record.interpretation).toEqual({
        interpretation_id: interpretation.record.interpretation_id,
        evidence_relation: 'supports',
      });
    }
  });

  it('publishes cited rejected alternatives without selecting them', () => {
    const text =
      'Choose SQLite for the local queue. An in-memory queue was rejected because it loses data on restart.';
    const manifest = manifestFor({ text });
    const optionCitation = quoteOf(manifest, 'An in-memory queue');
    const rejectionCitation = quoteOf(manifest, 'it loses data on restart');
    const plan = planFor(
      manifest,
      proposalOf(manifest, {
        statements: [
          statementOf({
            manifest,
            wording: 'Use SQLite for the local queue.',
            quote: 'Choose SQLite for the local queue.',
            source_form: 'stated_decision',
            proposed_record: 'decision',
            alternatives: [
              {
                option: 'Use an in-memory queue.',
                option_citations: [optionCitation],
                rejected_because: 'It loses data on restart.',
                rejection_citations: [rejectionCitation],
              },
            ],
          }),
        ],
      })
    );
    const interpretation = plan.records.find((record) => record.kind === 'interpretation');
    const decision = plan.records.find((record) => record.kind === 'decision_revision');

    expect(decision).toMatchObject({
      kind: 'decision_revision',
      record: {
        chosen_approach: 'Use SQLite for the local queue.',
        alternatives: [
          {
            option: 'Use an in-memory queue.',
            rejected_because: 'It loses data on restart.',
          },
        ],
      },
    });
    expect(interpretation).toMatchObject({
      kind: 'interpretation',
      record: {
        evidence: expect.arrayContaining([
          expect.objectContaining({ quote: optionCitation.quote }),
          expect.objectContaining({ quote: rejectionCitation.quote }),
        ]),
      },
    });
    expect(plan.quality).toMatchObject({ accepted: { statements: 1, alternatives: 1 } });
  });

  it('holds alternatives when an exact restatement publishes no decision revision', () => {
    const wording = 'Use SQLite.';
    const text = `${wording} An in-memory queue was rejected because it loses data on restart.`;
    const manifest = manifestFor({
      text,
      related: [
        existingKnowledge({
          kind: 'decision',
          entity_id: 'decision-storage',
          revision_id: 'decision-storage-r1',
          text: wording,
          intended_scope: { kind: 'artifact', artifact_id: 'artifact-offline-sync' },
        }),
      ],
    });
    const plan = planFor(
      manifest,
      proposalOf(manifest, {
        statements: [
          statementOf({
            manifest,
            wording,
            source_form: 'stated_decision',
            proposed_record: 'decision',
            alternatives: [
              {
                option: 'Use an in-memory queue.',
                option_citations: [quoteOf(manifest, 'An in-memory queue')],
                rejected_because: 'It loses data on restart.',
                rejection_citations: [quoteOf(manifest, 'it loses data on restart')],
              },
            ],
            links: [{ revision_ref: 'k1r1', relation: 'exact_restatement' }],
          }),
        ],
      })
    );

    expect(plan.records.some((record) => record.kind === 'decision_revision')).toBe(false);
    expect(plan.quality).toMatchObject({
      accepted: { statements: 1, links: 1, alternatives: 0 },
      held_back: { alternatives: 1 },
    });
  });

  it('materializes an observation only as an interpretation-backed candidate claim', () => {
    const manifest = manifestFor({ text: 'The nightly sync took 41 seconds.' });
    const plan = planFor(
      manifest,
      proposalOf(manifest, {
        statements: [
          statementOf({
            manifest,
            wording: 'The nightly sync took 41 seconds.',
            source_form: 'observation',
            proposed_record: 'claim',
          }),
        ],
      })
    );

    expect(plan.records.map((record) => record.kind)).toEqual(['interpretation', 'claim_revision']);
    const claim = plan.records[1];
    if (claim?.kind === 'claim_revision') {
      expect(claim.record).toMatchObject({
        source_standing: 'extracted_candidate',
        attributed_to: { kind: 'detector' },
        verification: null,
      });
    }
  });

  it('retains an exact repeat separately without minting another canonical revision', () => {
    const wording = 'The queue must work offline.';
    const manifest = manifestFor({
      text: wording,
      related: [
        existingKnowledge({
          kind: 'requirement',
          entity_id: 'requirement-offline',
          revision_id: 'requirement-offline-r1',
          text: wording,
          intended_scope: {
            kind: 'artifact',
            artifact_id: 'artifact-offline-sync',
          },
        }),
      ],
    });
    const plan = planFor(
      manifest,
      proposalOf(manifest, {
        statements: [
          statementOf({
            manifest,
            wording,
            links: [{ revision_ref: 'k1r1', relation: 'exact_restatement' }],
          }),
        ],
      })
    );

    expect(plan.records.map((record) => record.kind)).toEqual([
      'interpretation',
      'passage_restatement',
    ]);
    expect(plan.expected_state).toHaveLength(1);
  });

  it('retains evidence without a candidate when a bad identity link would duplicate wording', () => {
    const wording = 'The queue must work offline.';
    const manifest = manifestFor({
      text: wording,
      related: [
        existingKnowledge({
          kind: 'requirement',
          entity_id: 'requirement-offline',
          revision_id: 'requirement-offline-r1',
          text: wording,
          intended_scope: { kind: 'artifact', artifact_id: 'artifact-offline-sync' },
        }),
      ],
    });
    const plan = planFor(
      manifest,
      proposalOf(manifest, {
        statements: [
          statementOf({
            manifest,
            wording,
            links: [{ revision_ref: 'k9r9', relation: 'exact_restatement' }],
          }),
        ],
      })
    );

    expect(plan.records).toHaveLength(1);
    expect(plan.records[0]).toMatchObject({
      kind: 'interpretation',
      record: {
        wording,
        canonical_outcome: { kind: 'none', target: null },
      },
    });
    expect(plan.quality).toMatchObject({
      accepted: { statements: 0 },
      held_back: { statements: 1 },
      rejected: { links: 1 },
    });
  });

  it('keeps suggested relationships, task uses, and corrections authority-free', () => {
    const related = existingKnowledge({
      kind: 'requirement',
      entity_id: 'requirement-offline',
      revision_id: 'requirement-offline-r1',
      text: 'The queue works offline.',
    });
    const manifest = manifestFor({
      text: 'Keep drafts. The earlier queue statement is inaccurate.',
      related: [related],
    });
    const plan = planFor(
      manifest,
      proposalOf(manifest, {
        statements: [
          statementOf({
            manifest,
            wording: 'Keep drafts.',
            quote: 'Keep drafts.',
            links: [{ revision_ref: 'k1r1', relation: 'supports' }],
          }),
        ],
        corrections: [
          {
            kind: 'factual_correction',
            revision_ref: 'k1r1',
            account: quoteOf(manifest, 'The earlier queue statement is inaccurate.'),
          },
        ],
      })
    );
    const relationship = plan.records.find((record) => record.kind === 'relationship');
    const use = plan.records.find((record) => record.kind === 'task_use');
    const correction = plan.records.find((record) => record.kind === 'correction');

    expect(relationship).toMatchObject({
      record: { standing: 'suggested', authorization: null, attributed_to: { kind: 'detector' } },
    });
    expect(use).toMatchObject({
      record: { role: 'background', selection: { kind: 'connected_later' } },
    });
    expect(correction).toMatchObject({
      record: {
        kind: 'factual_correction',
        authorization: null,
        attributed_to: { kind: 'detector' },
      },
    });
    expect(plan.expected_state).toHaveLength(1);
    expect(plan.quality).toMatchObject({
      accepted: { statements: 1, corrections: 1, links: 1 },
      held_back: { statements: 0, corrections: 0, links: 0 },
    });
  });

  it('counts an unknown-scope relationship as held without changing rejected links', () => {
    const related = existingKnowledge({
      kind: 'claim',
      entity_id: 'claim-seedlings',
      revision_id: 'claim-seedlings-r1',
      text: 'The inspection found 18 damaged seedlings.',
    });
    const manifest = manifestFor({
      text: 'The inspection found 6 damaged seedlings, not 18.',
      related: [
        related,
        existingKnowledge({
          kind: 'claim',
          entity_id: 'claim-inspection-sheet',
          revision_id: 'claim-inspection-sheet-r1',
          text: 'The inspection sheet is the source of record.',
        }),
      ],
    });
    const plan = planFor(
      manifest,
      proposalOf(manifest, {
        statements: [
          statementOf({
            manifest,
            wording: 'The inspection found 6 damaged seedlings.',
            quote: 'The inspection found 6 damaged seedlings, not 18.',
            source_form: 'observation',
            proposed_record: 'claim',
            intended_scope: { kind: 'unknown' },
            links: [
              { revision_ref: 'k1r1', relation: 'contradicts' },
              { revision_ref: 'k2r1', relation: 'unrelated' },
              { revision_ref: 'k999r999', relation: 'supports' },
            ],
          }),
        ],
      })
    );

    expect(plan.records.some((record) => record.kind === 'relationship')).toBe(false);
    expect(plan.held_back).toContainEqual({
      item: { kind: 'link', statement_index: 0, link_index: 0 },
      reason: 'intended_scope_not_nameable',
      detail: 'A relationship is not published when the interpretation leaves its scope unknown.',
    });
    expect(plan.quality).toEqual({
      proposed: { statements: 1, corrections: 0, links: 3, uncertainties: 0, alternatives: 0 },
      accepted: { statements: 1, corrections: 0, links: 0, uncertainties: 0, alternatives: 0 },
      held_back: { statements: 0, corrections: 0, links: 2, uncertainties: 0, alternatives: 0 },
      rejected: { statements: 0, corrections: 0, links: 1, uncertainties: 0, alternatives: 0 },
    });
  });

  it('keeps a retained relationship accepted when no ancillary task use can be made', () => {
    const manifest = manifestFor({
      text: 'The audit result supports retaining logs.',
      related: [
        existingKnowledge({
          kind: 'requirement',
          entity_id: 'requirement-logs',
          revision_id: 'requirement-logs-r1',
          text: 'Retain audit logs.',
        }),
      ],
    });
    const sourceOnlyManifest = { ...manifest, task_context: null };
    const plan = planFor(
      sourceOnlyManifest,
      proposalOf(sourceOnlyManifest, {
        statements: [
          statementOf({
            manifest: sourceOnlyManifest,
            wording: 'Retain logs because the audit result supports it.',
            quote: 'The audit result supports retaining logs.',
            intended_scope: { kind: 'project' },
            links: [{ revision_ref: 'k1r1', relation: 'supports' }],
          }),
        ],
      })
    );

    expect(plan.records.some((record) => record.kind === 'relationship')).toBe(true);
    expect(plan.held_back).toContainEqual(
      expect.objectContaining({ reason: 'no_plan_event_in_manifest' })
    );
    expect(plan.quality).toMatchObject({
      accepted: { statements: 1, links: 1 },
      held_back: { statements: 0, links: 0 },
    });
  });

  it('keeps neighboring rationale evidence on the interpretation and all sources on the candidate', () => {
    const manifest = manifestFor({
      text: 'Choose SQLite here.',
      additional_sources: [
        {
          source_id: 'event-under-test#decisions[0].reason#0',
          text: 'It must continue working offline.',
          field_path: 'decisions[0].reason',
          role: 'reason',
          purpose: 'context',
        },
      ],
    });
    const plan = planFor(
      manifest,
      proposalOf(manifest, {
        statements: [
          statementOf({
            manifest,
            wording: 'Use SQLite.',
            quote: 'Choose SQLite here.',
            source_form: 'stated_decision',
            proposed_record: 'decision',
            rationale: {
              wording: 'It must work offline.',
              quote: 'It must continue working offline.',
              source_ref: 's2',
            },
          }),
        ],
      })
    );
    const interpretation = plan.records.find((record) => record.kind === 'interpretation');
    const decision = plan.records.find((record) => record.kind === 'decision_revision');
    expect(interpretation).toMatchObject({
      kind: 'interpretation',
      record: { rationale: { kind: 'stated' } },
    });
    if (interpretation?.kind === 'interpretation') {
      expect(interpretation.record.evidence.map((evidence) => evidence.source_id).sort()).toEqual([
        'event-under-test#decisions[0].reason#0',
        'event-under-test#summary#0',
      ]);
      if (interpretation.record.rationale.kind === 'stated') {
        expect(
          interpretation.record.rationale.evidence_positions.map(
            (position) => interpretation.record.evidence[position].source_id
          )
        ).toEqual(['event-under-test#decisions[0].reason#0']);
      }
    }
    if (decision?.kind === 'decision_revision') {
      expect([...decision.record.source_ids].sort()).toEqual([
        'event-under-test#decisions[0].reason#0',
        'event-under-test#summary#0',
      ]);
    }
  });

  it('reuses one candidate identity across changed evidence but retains distinct interpretations', () => {
    const manifest = manifestFor({ text: 'Keep drafts. Drafts remain after restart.' });
    const first = statementOf({
      manifest,
      wording: 'Drafts survive restart.',
      quote: 'Keep drafts.',
    });
    const second = {
      ...first,
      evidence: [quoteOf(manifest, 'Drafts remain after restart.')],
    };
    const firstPlan = planFor(manifest, proposalOf(manifest, { statements: [first] }));
    const secondPlan = planFor(manifest, proposalOf(manifest, { statements: [second] }));
    const firstInterpretation = firstPlan.records.find(
      (record) => record.kind === 'interpretation'
    );
    const secondInterpretation = secondPlan.records.find(
      (record) => record.kind === 'interpretation'
    );
    const firstCandidate = firstPlan.records.find(
      (record) => record.kind === 'requirement_revision'
    );
    const secondCandidate = secondPlan.records.find(
      (record) => record.kind === 'requirement_revision'
    );
    if (
      firstInterpretation?.kind === 'interpretation' &&
      secondInterpretation?.kind === 'interpretation' &&
      firstCandidate?.kind === 'requirement_revision' &&
      secondCandidate?.kind === 'requirement_revision'
    ) {
      expect(secondInterpretation.record.interpretation_id).not.toBe(
        firstInterpretation.record.interpretation_id
      );
      expect(secondCandidate.record.revision_id).toBe(firstCandidate.record.revision_id);
      expect(secondCandidate.record.requirement_id).toBe(firstCandidate.record.requirement_id);
    }
  });

  it('makes intended scope and exact refinement parent meaning-bearing candidate identity', () => {
    const related = existingKnowledge({
      kind: 'requirement',
      entity_id: 'requirement-offline',
      revision_id: 'requirement-offline-r1',
      text: 'Work offline.',
    });
    const manifest = manifestFor({ text: 'Queue writes work offline.', related: [related] });
    const project = statementOf({
      manifest,
      wording: 'Queue writes work offline.',
      intended_scope: { kind: 'project' },
    });
    const artifact = {
      ...project,
      intended_scope: { kind: 'current_task' as const },
    };
    const refined = {
      ...artifact,
      links: [{ revision_ref: 'k1r1', relation: 'refines' as const }],
    };
    const targets = [project, artifact, refined].map((statement) => {
      const validation = validateProposal({
        manifest,
        answer: proposalOf(manifest, { statements: [statement] }),
      });
      if (validation.outcome !== 'accepted') throw new Error('expected accepted proposal');
      return candidateTargetForStatement({
        manifest,
        accepted: validation.validated.statements[0],
      });
    });
    expect(new Set(targets.map((target) => target?.entity_id)).size).toBe(3);

    const refinedPlan = planFor(manifest, proposalOf(manifest, { statements: [refined] }));
    expect(
      refinedPlan.records.find((record) => record.kind === 'requirement_revision')
    ).toMatchObject({
      kind: 'requirement_revision',
      identity: {
        origin: {
          kind: 'derived',
          derived_from: { expectation: { revision_id: 'requirement-offline-r1' } },
        },
      },
    });
  });

  it('preserves candidate revision ids when no alternatives are present', () => {
    const cases = [
      {
        wording: 'Keep drafts.',
        source_form: 'stated_obligation' as const,
        proposed_record: 'requirement' as const,
        revision_id: 'c4915ac0-155b-88c3-ab23-8a8ff7b1c42d',
      },
      {
        wording: 'Use SQLite.',
        source_form: 'stated_decision' as const,
        proposed_record: 'decision' as const,
        revision_id: '4aec7e96-b400-8a17-b1c6-8671ad572334',
      },
      {
        wording: 'Drafts survived.',
        source_form: 'observation' as const,
        proposed_record: 'claim' as const,
        revision_id: '39d787de-5480-8f00-a2c7-ebe6900feddf',
      },
    ];

    for (const expected of cases) {
      const manifest = manifestFor({ text: expected.wording });
      const validation = validateProposal({
        manifest,
        answer: proposalOf(manifest, {
          statements: [
            statementOf({
              manifest,
              wording: expected.wording,
              source_form: expected.source_form,
              proposed_record: expected.proposed_record,
            }),
          ],
        }),
      });
      if (validation.outcome !== 'accepted') throw new Error('expected accepted proposal');

      expect(
        candidateTargetForStatement({ manifest, accepted: validation.validated.statements[0] })
          ?.revision_id
      ).toBe(expected.revision_id);
    }
  });

  it('changes a decision revision id when its rejected alternatives change', () => {
    const text =
      'Use SQLite. An in-memory queue loses data on restart. A remote queue adds operational overhead.';
    const manifest = manifestFor({ text });
    const base = statementOf({
      manifest,
      wording: 'Use SQLite.',
      source_form: 'stated_decision',
      proposed_record: 'decision',
    });
    const withAlternatives = (
      option: string,
      optionQuote: string,
      reason: string,
      reasonQuote: string
    ) => ({
      ...base,
      alternatives: [
        {
          option,
          option_citations: [quoteOf(manifest, optionQuote)],
          rejected_because: reason,
          rejection_citations: [quoteOf(manifest, reasonQuote)],
        },
      ],
    });
    const statements = [
      base,
      withAlternatives(
        'Use an in-memory queue.',
        'An in-memory queue',
        'It loses data on restart.',
        'loses data on restart'
      ),
      withAlternatives(
        'Use a remote queue.',
        'A remote queue',
        'It adds operational overhead.',
        'adds operational overhead'
      ),
    ];
    const targets = statements.map((statement) => {
      const validation = validateProposal({
        manifest,
        answer: proposalOf(manifest, { statements: [statement] }),
      });
      if (validation.outcome !== 'accepted') throw new Error('expected accepted proposal');
      return candidateTargetForStatement({
        manifest,
        accepted: validation.validated.statements[0],
      });
    });

    expect(new Set(targets.map((target) => target?.entity_id)).size).toBe(1);
    expect(new Set(targets.map((target) => target?.revision_id)).size).toBe(3);
  });

  it('retains an interpretation with no candidate outcome on a deterministic collision', () => {
    const manifest = manifestFor({
      text: 'Keep drafts.',
      related: [
        existingKnowledge({
          kind: 'claim',
          entity_id: 'claim-drafts',
          revision_id: 'claim-drafts-r1',
          text: 'Drafts are useful.',
        }),
      ],
    });
    const proposal = proposalOf(manifest, {
      statements: [
        statementOf({
          manifest,
          wording: 'Keep drafts.',
          links: [{ revision_ref: 'k1r1', relation: 'supports' }],
        }),
      ],
    });
    const validation = validateProposal({ manifest, answer: proposal });
    if (validation.outcome !== 'accepted') throw new Error('expected accepted proposal');
    const target = candidateTargetForStatement({
      manifest,
      accepted: validation.validated.statements[0],
    });
    if (target === null) throw new Error('expected candidate target');
    const plan = buildReconciliationPlan({
      manifest,
      validated: validation.validated,
      source_recorded_at: SOURCE_RECORDED_AT,
      candidate_state: [{ target, status: 'collision' }],
    });
    expect(plan.records).toHaveLength(1);
    expect(plan.records[0]).toMatchObject({
      kind: 'interpretation',
      record: { canonical_outcome: { kind: 'none', target: null } },
    });
    expect(plan.held_back).toContainEqual(
      expect.objectContaining({ reason: 'candidate_identity_collision' })
    );
    expect(plan.quality).toMatchObject({
      accepted: { statements: 0 },
      held_back: { statements: 1, links: 1 },
    });

    const replay = buildReconciliationPlan({
      manifest,
      validated: validation.validated,
      source_recorded_at: SOURCE_RECORDED_AT,
      candidate_state: [{ target, status: 'compatible' }],
    });
    expect(replay.held_back).toContainEqual(
      expect.objectContaining({ reason: 'candidate_already_retained' })
    );
    expect(replay.quality).toMatchObject({
      accepted: { statements: 1, links: 1 },
      held_back: { statements: 0, links: 0 },
    });
  });

  it('hashes canonical source aliases without changing provider manifest binding', () => {
    const manifest = manifestFor({ text: 'Keep drafts.', source_id: 'requested-source' });
    const proposal = proposalOf(manifest, {
      statements: [statementOf({ manifest, wording: 'Keep drafts.' })],
    });
    const validation = validateProposal({ manifest, answer: proposal });
    if (validation.outcome !== 'accepted') throw new Error('expected accepted proposal');
    const plan = buildReconciliationPlan({
      manifest,
      validated: validation.validated,
      source_recorded_at: SOURCE_RECORDED_AT,
      source_aliases: [{ requestedSourceId: 'requested-source', sourceId: 'canonical-source' }],
    });
    expect(plan.manifest_sha256).toBe(manifest.manifest_sha256);
    expect(plan.source_ids).toEqual(['canonical-source']);
    expect(plan.records[0]).toMatchObject({
      kind: 'interpretation',
      record: {
        source_origin: { source_id: 'canonical-source' },
        evidence: [{ source_id: 'canonical-source' }],
      },
    });
  });
});
