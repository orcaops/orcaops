import { describe, expect, it } from 'vitest';

import { derivedDigestFields, searchFieldsForEvent } from './fields.js';
import { classifySearchMatch, normalizeSearchQuery } from './matching.js';

describe('source-owned search fields', () => {
  it('keeps plan intent separate from criteria, non-goals, alternatives, and evidence quotes', () => {
    const fields = searchFieldsForEvent('plan_revised', {
      task: 'Durable project history',
      label: 'Project history',
      plan_steps: [
        {
          step_id: 'hidden identifier',
          label: 'Step label',
          text: 'step text',
          acceptance_criteria: [{ criterion_id: 'hidden criterion', text: 'prove outcome' }],
        },
      ],
      non_goals: [
        {
          text: 'network fallback',
          rationale: 'offline requirement',
          source_refs: ['hidden reference'],
        },
      ],
      decisions: [
        {
          decision: 'keep bytes',
          reason: 'preserve evidence',
          alternatives_considered: [
            { option: 'replace bytes', rejected_because: 'loses evidence' },
          ],
          evidence: { commit_sha: 'hidden commit', quote: 'original quote' },
        },
      ],
      rationale: 'revision reasoning',
      branch: 'hidden branch',
      touched_scope: ['hidden path'],
    });
    expect(fields.intent.map((field) => field.path)).toEqual(['task', 'label']);
    expect(fields.body.map((field) => field.text)).toEqual([
      'Step label',
      'step text',
      'prove outcome',
      'network fallback',
      'offline requirement',
      'keep bytes',
      'preserve evidence',
      'replace bytes',
      'loses evidence',
      'original quote',
      'revision reasoning',
    ]);
    expect(classifySearchMatch(fields, normalizeSearchQuery('project history'))).toBe(
      'intent_phrase'
    );
    expect(classifySearchMatch(fields, normalizeSearchQuery('hidden'))).toBeNull();
  });

  it('indexes only checkpoint-owned authored prose without inherited plan intent or cross-field phrases', () => {
    const fields = searchFieldsForEvent('checkpoint_closed', {
      task: 'Project history',
      label: 'Project history',
      summary: 'Durable project',
      uncertainty: ['history unavailable'],
      done_criteria: [{ criterion_id: 'hidden id', evidence: 'proof preserved' }],
      verification: [
        {
          command: 'hidden command',
          exit_code: 0,
          output_digest: 'six cases pass',
          note: 'native exclusion tested',
        },
      ],
      policy_exceptions: [{ reason: 'inherited open reason' }],
      files_changed: ['hidden file'],
    });
    expect(fields.intent).toEqual([]);
    expect(classifySearchMatch(fields, normalizeSearchQuery('project history'))).toBe('all_terms');
    expect(classifySearchMatch(fields, normalizeSearchQuery('six cases pass'))).toBe('text_phrase');
    expect(classifySearchMatch(fields, normalizeSearchQuery('hidden'))).toBeNull();
    expect(classifySearchMatch(fields, normalizeSearchQuery('inherited'))).toBeNull();
    expect(
      searchFieldsForEvent('checkpoint_opened', {
        policy_exceptions: [{ evaluator: 'hidden ref', reason: 'explicit exception' }],
      }).body.map((field) => field.text)
    ).toEqual(['explicit exception']);
    expect(
      searchFieldsForEvent('checkpoint_abandoned', {
        reason: 'preserve failed attempt',
        summary: 'inherited summary',
      }).body.map((field) => field.text)
    ).toEqual(['preserve failed attempt']);
  });

  it('preserves summary and typed diagnostic prose while excluding structural metadata and secret bytes', () => {
    expect(
      searchFieldsForEvent('summary_captured', {
        outcome: 'outcome',
        tests_written: ['written'],
        tests_run: ['run'],
        open_items: ['open'],
        deferred_decisions: ['deferred'],
        accepted_warnings: [{ reason: 'accepted warning' }],
      }).body.map((field) => field.text)
    ).toEqual(['outcome', 'written', 'run', 'open', 'deferred', 'accepted warning']);
    const secret = 'ghp_' + 'a'.repeat(36);
    const evaluator = searchFieldsForEvent('evaluator_run_recorded', {
      body: `diagnostic ${secret}`,
      evaluator_ref: 'hidden metadata',
      error: { code: 'hidden code', message: 'explicit error' },
      raw: { hidden: 'raw bytes' },
    });
    expect(evaluator.body.map((field) => field.text).join(' ')).not.toContain(secret);
    expect(classifySearchMatch(evaluator, normalizeSearchQuery('hidden'))).toBeNull();
    for (const type of [
      'evaluator_disposition_recorded',
      'block_acknowledged',
      'block_dismissed',
      'pin_displaced',
      'branch_lineage_updated',
    ] as const) {
      expect(
        searchFieldsForEvent(type, {
          reason: 'owned reason',
          evaluator_ref: 'hidden metadata',
        }).body.map((field) => field.text)
      ).toEqual(['owned reason']);
    }
    expect(searchFieldsForEvent('git_import_enriched', { task: 'enriched title' }).intent).toEqual(
      []
    );
  });

  it('labels digest fields by their original source and never gives generated content intent priority', () => {
    const digest = derivedDigestFields([
      {
        sourceId: 'plan-event',
        fields: searchFieldsForEvent('plan_captured', { task: 'Native exclusion' }),
      },
      {
        sourceId: 'checkpoint-event',
        fields: searchFieldsForEvent('checkpoint_closed', { summary: 'Retained proof' }),
      },
    ]);
    expect(digest.body.map((field) => field.path)).toEqual([
      'plan-event.task',
      'checkpoint-event.summary',
    ]);
    expect(classifySearchMatch(digest, normalizeSearchQuery('native exclusion'))).toBe(
      'text_phrase'
    );
    expect(classifySearchMatch(digest, normalizeSearchQuery('exclusion retained'))).toBe(
      'all_terms'
    );
  });
});
