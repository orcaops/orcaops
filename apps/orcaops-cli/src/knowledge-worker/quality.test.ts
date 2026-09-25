import { expect, it } from 'vitest';

import type { InterpretationManifest, ProposalValidation, ReconciliationPlan } from '@orcaops/core';
import type { InterpretationQuality } from '@orcaops/storage';

import { aggregateQuality, qualityFromValidation } from './quality.js';

function quality(
  outcome: InterpretationQuality['outcome'],
  counts: {
    proposed: number;
    accepted: number;
    heldBack: number;
    rejected: number;
  },
  diagnostics = 0
): InterpretationQuality {
  const collection = (value: number) => ({
    statements: value,
    corrections: 0,
    links: 0,
    uncertainties: 0,
  });
  return {
    schema: 'orcaops.interpretation_quality/v1',
    outcome,
    proposed: collection(counts.proposed),
    accepted: collection(counts.accepted),
    held_back: collection(counts.heldBack),
    rejected: collection(counts.rejected),
    diagnostics: Array.from({ length: diagnostics }, (_, index) => ({
      unit_id: `${index}`.padStart(64, 'a').slice(-64),
      source_id: `source-${index}`,
      field_path: 'task',
      collection: 'statements' as const,
      item_index: index,
      parent_index: null,
      rule: 'ITEM_SCHEMA_INVALID',
      detail: 'The item is malformed.',
    })),
    diagnostics_total: diagnostics,
    diagnostics_omitted: 0,
  };
}

it('keeps an early all-rejected unit visible beside a later clean unit', () => {
  const aggregate = aggregateQuality([
    quality('all_rejected', { proposed: 1, accepted: 0, heldBack: 0, rejected: 1 }, 1),
    quality('accepted', { proposed: 2, accepted: 2, heldBack: 0, rejected: 0 }),
  ]);

  expect(aggregate.quality).toMatchObject({
    outcome: 'partial',
    proposed: { statements: 3 },
    accepted: { statements: 2 },
    rejected: { statements: 1 },
    diagnostics_total: 1,
  });
  expect(aggregate.unit_outcomes).toEqual({
    accepted: 1,
    partial: 0,
    all_rejected: 1,
    empty: 0,
  });
});

it('bounds aggregate diagnostics while retaining their exact total', () => {
  const aggregate = aggregateQuality([
    quality('all_rejected', { proposed: 130, accepted: 0, heldBack: 0, rejected: 130 }, 130),
    quality('all_rejected', { proposed: 130, accepted: 0, heldBack: 0, rejected: 130 }, 130),
  ]);

  expect(aggregate.quality.diagnostics).toHaveLength(256);
  expect(aggregate.quality.diagnostics_total).toBe(260);
  expect(aggregate.quality.diagnostics_omitted).toBe(4);
});

it('keeps empty later units distinct from an earlier all-rejected unit', () => {
  const aggregate = aggregateQuality([
    quality('all_rejected', { proposed: 1, accepted: 0, heldBack: 0, rejected: 1 }, 1),
    quality('empty', { proposed: 0, accepted: 0, heldBack: 0, rejected: 0 }),
  ]);

  expect(aggregate.quality).toMatchObject({
    outcome: 'all_rejected',
    proposed: { statements: 1 },
    accepted: { statements: 0 },
    rejected: { statements: 1 },
  });
  expect(aggregate.unit_outcomes).toEqual({
    accepted: 0,
    partial: 0,
    all_rejected: 1,
    empty: 1,
  });
});

it('keeps an early partial unit distinct from later clean, empty and all-rejected units', () => {
  const aggregate = aggregateQuality([
    quality('partial', { proposed: 2, accepted: 1, heldBack: 0, rejected: 1 }, 1),
    quality('accepted', { proposed: 1, accepted: 1, heldBack: 0, rejected: 0 }),
    quality('empty', { proposed: 0, accepted: 0, heldBack: 0, rejected: 0 }),
    quality('all_rejected', { proposed: 1, accepted: 0, heldBack: 0, rejected: 1 }, 1),
  ]);

  expect(aggregate.quality).toMatchObject({
    outcome: 'partial',
    proposed: { statements: 4 },
    accepted: { statements: 2 },
    rejected: { statements: 2 },
    diagnostics_total: 2,
  });
  expect(aggregate.unit_outcomes).toEqual({
    accepted: 1,
    partial: 1,
    all_rejected: 1,
    empty: 1,
  });
});

it('diagnoses the held link rather than an earlier ancillary hold', () => {
  const counts = {
    proposed: { statements: 1, corrections: 0, links: 2, uncertainties: 0 },
    accepted: { statements: 1, corrections: 0, links: 2, uncertainties: 0 },
    held_back: { statements: 0, corrections: 0, links: 0, uncertainties: 0 },
    rejected: { statements: 0, corrections: 0, links: 0, uncertainties: 0 },
  };
  const manifest = {
    unit_id: 'a'.repeat(64),
    sources: [{ ref: 's1' }],
    segments: [
      {
        source_ref: 's1',
        source_id: 'source-1',
        purpose: 'primary',
        occurrence: { field_path: 'task' },
      },
    ],
  } as unknown as InterpretationManifest;
  const validation = {
    outcome: 'accepted',
    failures: [],
    validated: {
      quality: counts,
      statements: [
        {
          index: 0,
          statement: { proposed_record: 'claim' },
          links: [
            { index: 0, relation: 'supports' },
            { index: 1, relation: 'contradicts' },
          ],
        },
      ],
      corrections: [],
    },
  } as unknown as Extract<ProposalValidation, { outcome: 'accepted' }>;
  const reconciliation = {
    quality: {
      ...counts,
      accepted: { ...counts.accepted, links: 1 },
      held_back: { ...counts.held_back, links: 1 },
    },
    held_back: [
      {
        item: { kind: 'link', statement_index: 0, link_index: 0 },
        reason: 'task_use_refused_by_contract',
        detail: 'The ancillary task use was refused.',
      },
      {
        item: { kind: 'link', statement_index: 0, link_index: 1 },
        reason: 'intended_scope_not_nameable',
        detail: 'The relationship scope is unknown.',
      },
    ],
  } as unknown as ReconciliationPlan;

  const measured = qualityFromValidation({
    manifest,
    answer: { statements: [{ source_ref: 's1' }] },
    validation,
    reconciliation,
  });

  expect(measured.diagnostics).toEqual([
    expect.objectContaining({
      collection: 'links',
      item_index: 1,
      parent_index: 0,
      rule: 'RECONCILIATION_INTENDED_SCOPE_NOT_NAMEABLE',
    }),
  ]);
});

it('reports rejected alternatives separately from their accepted decision', () => {
  const counts = {
    proposed: { statements: 1, corrections: 0, links: 0, uncertainties: 0, alternatives: 1 },
    accepted: { statements: 1, corrections: 0, links: 0, uncertainties: 0, alternatives: 0 },
    held_back: { statements: 0, corrections: 0, links: 0, uncertainties: 0, alternatives: 0 },
    rejected: { statements: 0, corrections: 0, links: 0, uncertainties: 0, alternatives: 1 },
  };
  const manifest = {
    unit_id: 'a'.repeat(64),
    sources: [{ ref: 's1' }],
    segments: [
      {
        source_ref: 's1',
        source_id: 'source-1',
        purpose: 'primary',
        occurrence: { field_path: 'decisions.0' },
      },
    ],
  } as unknown as InterpretationManifest;
  const validation = {
    outcome: 'accepted',
    failures: [
      {
        rule: 'CITATION_NOT_FOUND',
        item: { kind: 'alternative', statement_index: 0, alternative_index: 0 },
        detail: 'The rejection quote was not found.',
      },
    ],
    validated: { quality: counts, statements: [], corrections: [] },
  } as unknown as Extract<ProposalValidation, { outcome: 'accepted' }>;
  const measured = qualityFromValidation({
    manifest,
    answer: { statements: [{ source_ref: 's1' }] },
    validation,
    reconciliation: { quality: counts, held_back: [] } as unknown as ReconciliationPlan,
  });

  expect(measured).toMatchObject({
    outcome: 'partial',
    diagnostics: [
      {
        collection: 'alternatives',
        item_index: 0,
        parent_index: 0,
        rule: 'CITATION_NOT_FOUND',
      },
    ],
  });
});
