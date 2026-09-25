import { describe, expect, it } from 'vitest';

import { measurePreparedInputRequest } from '@orcaops/llm';

import { manifestFor, SOURCE_RECORDED_AT } from '../fixture.test-support.js';
import type { PublishableRecord } from '../reconciliation.js';
import { runCase, scoreCase } from './harness.js';
import { existingKnowledge, spanOf } from './knowledge.js';
import { scriptedProposer } from './scripted-proposer.js';
import { emptyProposer, everyLineProposer } from './unhelpful-proposers.js';

const OPTIONS = {
  provider: 'claude' as const,
  measure: { measurePreparedInputRequest },
  processed_at: '2026-04-02T09:15:00.000Z',
  source_recorded_at: SOURCE_RECORDED_AT,
};

describe('the deterministic evaluation harness', () => {
  it('distinguishes a complete extraction from an empty answer', async () => {
    const text = 'Inspection notes must survive a device restart.';
    const manifest = manifestFor({ text });
    const expected = {
      published: [{ ...spanOf(text, text), record: 'requirement' as const }],
      reuse: [],
      restated: [],
      never_published: [],
    };
    const complete = await runCase(
      scriptedProposer({
        [manifest.sources[0].source_id]: {
          statements: [
            { quote: text, source_form: 'stated_obligation', proposed_record: 'requirement' },
          ],
        },
      }),
      { name: 'complete obligation', source_text: text, manifest, expected },
      OPTIONS
    );
    const empty = await runCase(
      emptyProposer,
      { name: 'empty answer', source_text: text, manifest, expected },
      OPTIONS
    );

    expect(complete.counts).toEqual({
      false_merges: 0,
      incorrect_equivalences: 0,
      missed_equivalences: 0,
      unauthorized_promotions: 0,
      unsupported_citations: 0,
      missed_statements: 0,
      unexpected_records: 0,
    });
    expect(empty.counts).toMatchObject({ missed_statements: 1, unexpected_records: 0 });
  });

  it('counts a forbidden passage promoted by an every-line proposer', async () => {
    const text = 'This note is background only.';
    const manifest = manifestFor({ text });
    const outcome = await runCase(
      everyLineProposer,
      {
        name: 'background note',
        source_text: text,
        manifest,
        expected: {
          published: [],
          reuse: [],
          restated: [],
          never_published: [spanOf(text, text)],
        },
      },
      OPTIONS
    );

    expect(outcome.counts).toMatchObject({
      unauthorized_promotions: 1,
      unexpected_records: 1,
    });
  });

  it('counts duplicate candidate rows one-to-one instead of double-crediting them', async () => {
    const text = 'Inspection notes must survive a device restart.';
    const manifest = manifestFor({ text });
    const expected = {
      published: [{ ...spanOf(text, text), record: 'requirement' as const }],
      reuse: [],
      restated: [],
      never_published: [],
    };
    const outcome = await runCase(
      scriptedProposer({
        [manifest.sources[0].source_id]: {
          statements: [
            { quote: text, source_form: 'stated_obligation', proposed_record: 'requirement' },
          ],
        },
      }),
      { name: 'complete obligation', source_text: text, manifest, expected },
      OPTIONS
    );
    const candidate = outcome.plan?.records.find(
      (record) => record.kind === 'requirement_revision'
    );
    expect(candidate).toBeDefined();
    const scored = scoreCase({
      expected,
      manifest,
      plan:
        outcome.plan === null || candidate === undefined
          ? null
          : { ...outcome.plan, records: [...outcome.plan.records, candidate] },
      failures: [],
    });
    expect(scored.counts).toMatchObject({ missed_statements: 0, unexpected_records: 1 });
  });

  it('flags an established detector relationship as an authority promotion', async () => {
    const target = existingKnowledge({
      kind: 'requirement',
      entity_id: 'requirement-offline',
      revision_id: 'requirement-offline-r1',
      text: 'Work offline.',
    });
    const text = 'Queue writes must work offline.';
    const manifest = manifestFor({ text, related: [target] });
    const outcome = await runCase(
      scriptedProposer({
        [manifest.sources[0].source_id]: {
          statements: [
            {
              quote: text,
              source_form: 'stated_obligation',
              proposed_record: 'requirement',
              links: [{ ref: 'k1r1', relation: 'supports' }],
            },
          ],
        },
      }),
      {
        name: 'suggested support',
        source_text: text,
        manifest,
        expected: {
          published: [{ ...spanOf(text, text), record: 'requirement' }],
          reuse: [],
          restated: [],
          never_published: [],
        },
      },
      OPTIONS
    );
    const relationship = outcome.plan?.records.find((record) => record.kind === 'relationship');
    expect(relationship).toBeDefined();
    const established = {
      ...relationship,
      record: { ...relationship?.record, standing: 'established' },
    } as PublishableRecord;
    const score = scoreCase({
      expected: {
        published: [],
        reuse: [],
        restated: [],
        never_published: [],
      },
      manifest,
      plan: outcome.plan === null ? null : { ...outcome.plan, records: [established] },
      failures: [],
    });
    expect(score.counts).toMatchObject({ unauthorized_promotions: 1 });
  });

  it('does not score neighboring rationale evidence as promoted statement wording', async () => {
    const wording = 'Choose SQLite.';
    const reason = 'Because offline access matters.';
    const manifest = manifestFor({
      text: wording,
      additional_sources: [
        {
          source_id: 'event-under-test#decision.reason#0',
          text: reason,
          field_path: 'decision.reason',
          purpose: 'context',
          role: 'reason',
        },
      ],
    });
    const outcome = await runCase(
      scriptedProposer({
        [manifest.sources[0].source_id]: {
          statements: [
            {
              quote: wording,
              source_form: 'stated_decision',
              proposed_record: 'decision',
              rationale: reason,
            },
          ],
        },
      }),
      {
        name: 'decision and neighboring reason',
        source_text: wording,
        manifest,
        expected: {
          published: [
            {
              ...spanOf(wording, wording),
              source_id: manifest.sources[0].source_id,
              record: 'decision',
            },
          ],
          reuse: [],
          restated: [],
          never_published: [
            {
              ...spanOf(reason, reason),
              source_id: manifest.sources[1].source_id,
            },
          ],
        },
      },
      OPTIONS
    );

    expect(outcome.counts).toEqual({
      false_merges: 0,
      incorrect_equivalences: 0,
      missed_equivalences: 0,
      unauthorized_promotions: 0,
      unsupported_citations: 0,
      missed_statements: 0,
      unexpected_records: 0,
    });
  });

  it('scores a supported equivalence separately from revisions and restatements', async () => {
    const target = existingKnowledge({
      kind: 'requirement',
      entity_id: 'requirement-precision',
      revision_id: 'requirement-precision-r2',
      text: 'Display measurements to two decimal places.',
    });
    const manifest = manifestFor({
      text: 'Show two digits after the decimal point.',
      related: [target],
    });
    const evaluated = {
      name: 'equivalent wording',
      source_text: 'Show two digits after the decimal point.',
      manifest,
      expected: {
        published: [],
        reuse: [],
        restated: [],
        never_published: [],
        equivalences: [
          {
            kind: 'requirement' as const,
            entity_id: 'requirement-precision',
            revision_id: 'requirement-precision-r2',
          },
        ],
      },
    };
    const outcome = await runCase(
      scriptedProposer({
        [manifest.sources[0].source_id]: {
          statements: [
            {
              quote: 'Show two digits after the decimal point.',
              source_form: 'stated_obligation',
              proposed_record: 'requirement',
              links: [{ ref: 'k1r1', relation: 'equivalent_to' }],
            },
          ],
        },
      }),
      evaluated,
      OPTIONS
    );

    expect(outcome.counts.incorrect_equivalences).toBe(0);
    expect(outcome.counts.missed_equivalences).toBe(0);
    expect(outcome.plan?.records.map((record) => record.kind)).toEqual(['interpretation']);
  });

  it('scores a wrong proposed equivalence without calling it a canonical merge', async () => {
    const target = existingKnowledge({
      kind: 'requirement',
      entity_id: 'requirement-all-users',
      revision_id: 'requirement-all-users-r1',
      text: 'All users must approve exports.',
    });
    const manifest = manifestFor({ text: 'Admins should approve exports.', related: [target] });
    const outcome = await runCase(
      scriptedProposer({
        [manifest.sources[0].source_id]: {
          statements: [
            {
              quote: 'Admins should approve exports.',
              source_form: 'stated_obligation',
              proposed_record: 'requirement',
              links: [{ ref: 'k1r1', relation: 'equivalent_to' }],
            },
          ],
        },
      }),
      {
        name: 'different subject and strength',
        source_text: 'Admins should approve exports.',
        manifest,
        expected: { published: [], reuse: [], restated: [], never_published: [] },
      },
      OPTIONS
    );
    expect(outcome.counts.incorrect_equivalences).toBe(1);
    expect(outcome.counts.false_merges).toBe(0);
    expect(outcome.counts.unexpected_records).toBe(0);
  });

  it('keeps unsupported evidence distinct from semantic disagreement', async () => {
    const manifest = manifestFor({ text: 'Keep drafts.' });
    const outcome = await runCase(
      scriptedProposer({
        [manifest.sources[0].source_id]: {
          statements: [
            {
              quote: 'Keep drafts.',
              source_form: 'stated_obligation',
              proposed_record: 'requirement',
              invented_quote: 'Delete drafts.',
            },
          ],
        },
      }),
      {
        name: 'unsupported evidence',
        source_text: 'Keep drafts.',
        manifest,
        expected: { published: [], reuse: [], restated: [], never_published: [] },
      },
      OPTIONS
    );
    expect(outcome.counts.unsupported_citations).toBe(1);
    expect(outcome.counts.incorrect_equivalences).toBe(0);
  });

  it('counts malformed citation structure as invalid evidence', async () => {
    const text = 'Keep drafts.';
    const manifest = manifestFor({ text });
    const outcome = await runCase(
      (request) =>
        Promise.resolve({
          status: 'answered',
          body: JSON.stringify({
            proposal_schema_version: request.manifest.proposal_schema_version,
            manifest_sha256: request.manifest.manifest_sha256,
            statements: [
              {
                source_ref: 's1',
                wording: text,
                source_form: 'stated_obligation',
                proposed_record: 'requirement',
                intended_scope: { kind: 'project' },
                evidence: [{ quote: text }],
                rationale: { kind: 'unknown' },
                alternatives: [],
                links: [],
              },
            ],
            corrections: [],
            uncertainties: [],
          }),
        }),
      {
        name: 'malformed citation',
        source_text: text,
        manifest,
        expected: { published: [], reuse: [], restated: [], never_published: [] },
      },
      OPTIONS
    );

    expect(outcome.counts).toMatchObject({
      unsupported_citations: 1,
      incorrect_equivalences: 0,
    });
  });
});
