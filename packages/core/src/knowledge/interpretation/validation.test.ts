import { describe, expect, it } from 'vitest';

import { existingKnowledge } from './evaluation/knowledge.js';
import { manifestFor, proposalOf, quoteOf, statementOf } from './fixture.test-support.js';
import { PROPOSAL_LIMITS } from './proposal.js';
import { interpretationQuality, validateProposal } from './validation.js';

const accepted = (validation: ReturnType<typeof validateProposal>) => {
  expect(validation.outcome).toBe('accepted');
  if (validation.outcome !== 'accepted') throw new Error('expected accepted proposal');
  return validation;
};

describe('deterministic interpretation validation', () => {
  it.each([null, { artifact_id: 'another-focused-task', plan_event_id: 'another-plan' }])(
    'resolves current task from the source even when task context is %j',
    (task_context) => {
      const manifest = manifestFor({ text: 'Inspect the sample.', task_context });
      const validation = accepted(
        validateProposal({
          manifest,
          answer: proposalOf(manifest, {
            statements: [
              statementOf({
                manifest,
                wording: 'Inspect the sample.',
                source_form: 'task_local_criterion',
                proposed_record: 'none',
                intended_scope: { kind: 'current_task' },
              }),
            ],
          }),
        })
      );
      expect(validation.failures).toEqual([]);
      expect(validation.validated.statements[0].statement.intended_scope).toEqual({
        kind: 'artifact',
        artifact_id: manifest.sources[0].occurrence.artifact_id,
      });
    }
  );

  it('uses the named primary source rather than another source in the manifest', () => {
    const manifest = manifestFor({
      text: 'Inspect the first sample.',
      additional_sources: [
        {
          source_id: 'second-source',
          text: 'Inspect the second sample.',
          field_path: 'plan_steps.0.text',
          role: 'step',
          artifact_id: 'second-source-task',
        },
      ],
    });
    const validation = accepted(
      validateProposal({
        manifest,
        answer: proposalOf(manifest, {
          statements: [
            statementOf({
              manifest,
              source_ref: 's2',
              wording: 'Inspect the second sample.',
              source_form: 'task_local_criterion',
              proposed_record: 'none',
              intended_scope: { kind: 'current_task' },
            }),
          ],
        }),
      })
    );
    expect(validation.failures).toEqual([]);
    expect(validation.validated.statements[0].statement.intended_scope).toEqual({
      kind: 'artifact',
      artifact_id: 'second-source-task',
    });
  });

  it.each([
    { kind: 'artifact', artifact_id: 'artifact-offline-sync' },
    { kind: 'artifact', artifact_id: 'older-task' },
    { kind: 'current_task', artifact_id: 'older-task' },
  ])('rejects provider-supplied task identifiers in %j without losing a valid sibling', (scope) => {
    const manifest = manifestFor({ text: 'Inspect the sample. Keep labels readable.' });
    const validation = accepted(
      validateProposal({
        manifest,
        answer: {
          ...proposalOf(manifest),
          statements: [
            {
              ...statementOf({ manifest, wording: 'Inspect the sample.' }),
              intended_scope: scope,
            },
            statementOf({
              manifest,
              wording: 'Keep labels readable.',
              intended_scope: { kind: 'project' },
            }),
          ],
        },
      })
    );
    expect(validation.failures).toEqual([
      expect.objectContaining({
        rule: 'ITEM_SCHEMA_INVALID',
        item: { kind: 'statement', index: 0 },
      }),
    ]);
    expect(validation.validated.statements).toHaveLength(1);
    expect(validation.validated.statements[0].statement.wording).toBe('Keep labels readable.');
  });

  it('rejects an out-of-scope restatement link while retaining the scoped statement', () => {
    const wording = 'Keep labels readable.';
    const manifest = manifestFor({
      text: wording,
      related: [
        existingKnowledge({
          kind: 'requirement',
          entity_id: 'older-label-rule',
          revision_id: 'older-label-revision',
          text: wording,
          intended_scope: { kind: 'artifact', artifact_id: 'older-task' },
        }),
      ],
    });
    const validation = accepted(
      validateProposal({
        manifest,
        answer: proposalOf(manifest, {
          statements: [
            statementOf({
              manifest,
              wording,
              intended_scope: { kind: 'current_task' },
              links: [{ revision_ref: 'k1r1', relation: 'exact_restatement' }],
            }),
          ],
        }),
      })
    );
    expect(validation.validated.statements).toHaveLength(1);
    expect(validation.validated.statements[0]).toMatchObject({
      identity: { kind: 'new' },
      links: [],
    });
    expect(validation.failures.map((failure) => failure.rule)).toEqual([
      'EXACT_RESTATEMENT_NOT_VERBATIM',
    ]);
    expect(validation.validated.quality).toMatchObject({
      accepted: { statements: 1 },
      rejected: { statements: 0, links: 1 },
    });
  });

  it('rejects an actor-attributed manifest before considering its proposal', () => {
    const manifest = manifestFor({
      text: 'Keep drafts.',
      attributed_to: {
        kind: 'actor',
        actor: { identity: 'owner', basis: 'authenticated' },
      },
    });
    const validation = validateProposal({ manifest, answer: proposalOf(manifest) });
    expect(validation).toMatchObject({
      outcome: 'rejected',
      failures: [{ rule: 'ATTRIBUTION_NOT_A_DETECTOR' }],
    });
  });

  it('rejects wrong version and manifest bindings as whole answers', () => {
    const manifest = manifestFor({ text: 'Keep drafts.' });
    expect(
      validateProposal({
        manifest,
        answer: { ...proposalOf(manifest), proposal_schema_version: 'knowledge-proposal@1' },
      })
    ).toMatchObject({ outcome: 'rejected', failures: [{ rule: 'PROPOSAL_VERSION_MISMATCH' }] });
    expect(
      validateProposal({
        manifest,
        answer: { ...proposalOf(manifest), manifest_sha256: 'f'.repeat(64) },
      })
    ).toMatchObject({ outcome: 'rejected', failures: [{ rule: 'MANIFEST_MISMATCH' }] });
  });

  it.each(['authorization', 'designation', 'approved_by', 'actor', 'standing'])(
    'rejects authority-bearing field %s as a whole answer',
    (field) => {
      const manifest = manifestFor({ text: 'Keep drafts.' });
      const statement = statementOf({ manifest, wording: 'Keep drafts.' });
      const validation = validateProposal({
        manifest,
        answer: proposalOf(manifest, {
          statements: [{ ...statement, [field]: 'owner' } as typeof statement],
        }),
      });
      expect(validation).toMatchObject({
        outcome: 'rejected',
        failures: [{ rule: 'UNSAFE_AUTHORITY_FIELD' }],
      });
    }
  );

  it('rejects an over-limit collection instead of truncating it', () => {
    const manifest = manifestFor({ text: 'Keep drafts.' });
    const statement = statementOf({ manifest, wording: 'Keep drafts.' });
    const validation = validateProposal({
      manifest,
      answer: {
        ...proposalOf(manifest),
        statements: Array.from({ length: PROPOSAL_LIMITS.statements + 1 }, () => statement),
      },
    });
    expect(validation).toMatchObject({
      outcome: 'rejected',
      failures: [{ rule: 'SCHEMA_INVALID' }],
    });
  });

  it('locates a unique quotation and maps prepared UTF-8 bytes back to original bytes', () => {
    const text = `Préface${String.fromCharCode(0)}: 🚲 queues stay offline.`;
    const manifest = manifestFor({ text });
    const proposal = proposalOf(manifest, {
      statements: [
        statementOf({
          manifest,
          wording: 'The queue works without a network.',
          quote: '🚲 queues stay offline.',
        }),
      ],
    });

    const validation = accepted(validateProposal({ manifest, answer: proposal }));
    const evidence = validation.validated.statements[0].evidence[0];
    expect(evidence.quote).toBe('🚲 queues stay offline.');
    expect(evidence.prepared_end_utf8 - evidence.prepared_start_utf8).toBe(
      Buffer.byteLength(evidence.quote, 'utf8')
    );
    expect(evidence.original_ranges).toHaveLength(1);
    expect(validation.validated.statements[0].statement.wording).not.toBe(evidence.quote);
  });

  it('keeps separate original ranges when one prepared quote crosses a removed control', () => {
    const manifest = manifestFor({ text: `alpha${String.fromCharCode(0)}beta` });
    const validation = accepted(
      validateProposal({
        manifest,
        answer: proposalOf(manifest, {
          statements: [statementOf({ manifest, wording: 'alpha beta', quote: 'alphabeta' })],
        }),
      })
    );
    expect(validation.validated.statements[0].evidence[0].original_ranges).toEqual([
      { start: 0, end: 5 },
      { start: 6, end: 10 },
    ]);
  });

  it('retains an explicit unknown decision rationale', () => {
    const manifest = manifestFor({ text: 'Choose SQLite for the local queue.' });
    const proposal = proposalOf(manifest, {
      statements: [
        statementOf({
          manifest,
          wording: 'Use SQLite for the local queue.',
          quote: 'Choose SQLite for the local queue.',
          source_form: 'stated_decision',
          proposed_record: 'decision',
        }),
      ],
    });
    expect(
      accepted(validateProposal({ manifest, answer: proposal })).validated.statements[0].rationale
    ).toEqual({ kind: 'unknown' });
  });

  it('resolves a decision reason from a neighboring context field', () => {
    const manifest = manifestFor({
      text: 'Choose SQLite for the local queue.',
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
    const proposal = proposalOf(manifest, {
      statements: [
        statementOf({
          manifest,
          wording: 'Use SQLite for the local queue.',
          quote: 'Choose SQLite for the local queue.',
          source_form: 'stated_decision',
          proposed_record: 'decision',
          rationale: {
            wording: 'The queue must work offline.',
            quote: 'It must continue working offline.',
            source_ref: 's2',
          },
        }),
      ],
    });

    const statement = accepted(validateProposal({ manifest, answer: proposal })).validated
      .statements[0];
    expect(statement.rationale).toMatchObject({
      kind: 'stated',
      wording: 'The queue must work offline.',
    });
    if (statement.rationale.kind === 'stated') {
      expect(statement.rationale.evidence[0].source_id).toBe(
        'event-under-test#decisions[0].reason#0'
      );
    }
  });

  it.each(['non_goal', 'rejected_alternative'] as const)(
    'cannot hide %s evidence behind a neutral task origin',
    (role) => {
      const manifest = manifestFor({
        text: 'Prepare local notes.',
        primary_role: 'task',
        additional_sources: [
          {
            source_id: 'excluded',
            text: 'Use a remote queue.',
            field_path: 'non_goals.0.text',
            role,
          },
        ],
      });
      const result = accepted(
        validateProposal({
          manifest,
          answer: proposalOf(manifest, {
            statements: [
              statementOf({
                manifest,
                wording: 'Use a remote queue.',
                evidence: [quoteOf(manifest, 'Use a remote queue.', 's2')],
              }),
            ],
          }),
        })
      );
      expect(result.validated.statements).toEqual([]);
      expect(result.failures).toEqual([
        expect.objectContaining({ rule: 'PRIMARY_ORIGIN_NOT_EVIDENCED' }),
      ]);
    }
  );

  it('retains supporting context alongside evidence from the stated primary origin', () => {
    const manifest = manifestFor({
      text: 'Keep drafts offline.',
      additional_sources: [
        {
          source_id: 'context',
          text: 'Drafts are local working copies.',
          field_path: 'label',
          role: 'task',
          purpose: 'context',
        },
      ],
    });
    const statement = statementOf({
      manifest,
      wording: 'Working copies remain available without a network.',
      evidence: [
        quoteOf(manifest, 'Keep drafts offline.'),
        quoteOf(manifest, 'Drafts are local working copies.', 's2'),
      ],
    });
    const result = accepted(
      validateProposal({ manifest, answer: proposalOf(manifest, { statements: [statement] }) })
    );
    expect(result.failures).toEqual([]);
    expect(result.validated.statements[0].evidence).toHaveLength(2);
  });

  it('does not count a rationale citation as evidence of the statement origin', () => {
    const manifest = manifestFor({
      text: 'Choose SQLite.',
      additional_sources: [
        {
          source_id: 'reason',
          text: 'It works offline.',
          field_path: 'decisions.0.reason',
          role: 'reason',
          purpose: 'context',
        },
      ],
    });
    const result = accepted(
      validateProposal({
        manifest,
        answer: proposalOf(manifest, {
          statements: [
            statementOf({
              manifest,
              wording: 'Use SQLite.',
              source_form: 'stated_decision',
              proposed_record: 'decision',
              evidence: [quoteOf(manifest, 'It works offline.', 's2')],
              rationale: { wording: 'Local choice.', quote: 'Choose SQLite.' },
            }),
          ],
        }),
      })
    );
    expect(result.validated.statements).toEqual([]);
    expect(result.failures[0].rule).toBe('PRIMARY_ORIGIN_NOT_EVIDENCED');
  });

  it('rejects only a malformed sibling and reports honest item counts', () => {
    const manifest = manifestFor({ text: 'Keep drafts. Retry later.' });
    const good = statementOf({ manifest, wording: 'Keep drafts.', quote: 'Keep drafts.' });
    const validation = accepted(
      validateProposal({
        manifest,
        answer: proposalOf(manifest, {
          statements: [
            { ...good, proposed_record: 'invented' } as never,
            statementOf({ manifest, wording: 'Retry later.', quote: 'Retry later.' }),
          ],
        }),
      })
    );
    expect(validation.validated.statements.map((item) => item.index)).toEqual([1]);
    expect(validation.validated.quality).toMatchObject({
      proposed: { statements: 2 },
      accepted: { statements: 1 },
      rejected: { statements: 1 },
    });
    expect(validation.failures[0]).toMatchObject({
      rule: 'ITEM_SCHEMA_INVALID',
      item: { kind: 'statement', index: 0 },
    });
    expect(
      interpretationQuality({
        validation,
        unit_id: manifest.unit_id,
        locate: () => ({ source_id: manifest.sources[0].source_id, field_path: 'summary' }),
      })
    ).toMatchObject({
      outcome: 'partial',
      proposed: { statements: 2 },
      accepted: { statements: 1 },
      rejected: { statements: 1 },
      diagnostics_total: 1,
    });
  });

  it('rejects an overlong item without discarding an independent sibling', () => {
    const manifest = manifestFor({ text: 'Keep drafts. Retry later.' });
    const good = statementOf({ manifest, wording: 'Keep drafts.', quote: 'Keep drafts.' });
    const validation = accepted(
      validateProposal({
        manifest,
        answer: proposalOf(manifest, {
          statements: [
            { ...good, wording: 'x'.repeat(PROPOSAL_LIMITS.text_chars + 1) },
            statementOf({ manifest, wording: 'Retry later.', quote: 'Retry later.' }),
          ],
        }),
      })
    );

    expect(validation.validated.statements.map((item) => item.index)).toEqual([1]);
    expect(validation.failures[0]).toMatchObject({
      rule: 'ITEM_SCHEMA_INVALID',
      item: { kind: 'statement', index: 0 },
    });
  });

  it('rejects an ambiguous quote within its named segment without searching elsewhere', () => {
    const manifest = manifestFor({ text: 'same words; same words' });
    const proposal = proposalOf(manifest, {
      statements: [statementOf({ manifest, wording: 'Same words apply.', quote: 'same words' })],
    });
    const validation = accepted(validateProposal({ manifest, answer: proposal }));
    expect(validation.validated.statements).toEqual([]);
    expect(validation.failures.map((failure) => failure.rule)).toContain('CITATION_AMBIGUOUS');
  });

  it('resolves short citations to retained hashes and rejects mismatched source references', () => {
    const manifest = manifestFor({
      text: 'Keep drafts.',
      additional_sources: [{ source_id: 'retry', text: 'Retry later.', field_path: 'outcome' }],
    });
    const good = statementOf({ manifest, wording: 'Keep drafts.', quote: 'Keep drafts.' });
    const validation = accepted(
      validateProposal({
        manifest,
        answer: proposalOf(manifest, {
          statements: [
            good,
            { ...good, evidence: [{ source_ref: 's1', segment_ref: 'g2', quote: 'Retry later.' }] },
            {
              ...good,
              evidence: [{ source_ref: 's1', segment_ref: 'g999', quote: 'Keep drafts.' }],
            },
          ],
        }),
      })
    );
    expect(validation.validated.statements.map((statement) => statement.index)).toEqual([0]);
    expect(validation.validated.statements[0]!.evidence[0]).toMatchObject({
      segment_id: manifest.segments[0].segment_id,
      prepared_start_utf8: 0,
      prepared_end_utf8: 12,
      original_ranges: [{ start: 0, end: 12 }],
      quote: 'Keep drafts.',
    });
    expect(validation.failures.map((failure) => failure.rule)).toEqual([
      'SEGMENT_NOT_IN_MANIFEST',
      'SEGMENT_NOT_IN_MANIFEST',
    ]);
  });

  it('rejects a quote that intersects substituted secret text', () => {
    const secret = 'ghp_123456789012345678901234567890123456';
    const manifest = manifestFor({ text: `Token ${secret} must not leak.` });
    const redacted = manifest.segments[0].text;
    expect(redacted).not.toContain(secret);
    const proposal = proposalOf(manifest, {
      statements: [
        {
          ...statementOf({ manifest, wording: 'A token was redacted.', quote: 'must not leak.' }),
          evidence: [quoteOf(manifest, '[REDACTED_SECRET]')],
        },
      ],
    });
    const validation = accepted(validateProposal({ manifest, answer: proposal }));
    expect(validation.failures.map((failure) => failure.rule)).toContain(
      'CITATION_TOUCHES_REDACTION'
    );
  });

  it('pins a proposed equivalence to one exact retrieved revision', () => {
    const related = existingKnowledge({
      kind: 'requirement',
      entity_id: 'requirement-precision',
      revision_id: 'requirement-precision-r2',
      text: 'Display measurements to two decimal places.',
    });
    const manifest = manifestFor({
      text: 'Show two digits after the decimal point.',
      related: [related],
    });
    const proposal = proposalOf(manifest, {
      statements: [
        statementOf({
          manifest,
          wording: 'Show two digits after the decimal point.',
          links: [{ revision_ref: 'k1r1', relation: 'equivalent_to' }],
        }),
      ],
    });
    const statement = accepted(validateProposal({ manifest, answer: proposal })).validated
      .statements[0];
    expect(statement.identity).toEqual({
      kind: 'proposed_equivalence',
      revision: {
        kind: 'requirement',
        entity_id: 'requirement-precision',
        revision_id: 'requirement-precision-r2',
      },
    });
  });

  it('requires an exact restatement link for matching wording in a compatible scope', () => {
    const wording = 'All measurements must use two decimal places.';
    const related = existingKnowledge({
      kind: 'requirement',
      entity_id: 'requirement-precision',
      revision_id: 'requirement-precision-r2',
      text: wording,
      intended_scope: { kind: 'project' },
    });
    const manifest = manifestFor({ text: wording, related: [related] });
    const validation = accepted(
      validateProposal({
        manifest,
        answer: proposalOf(manifest, {
          statements: [statementOf({ manifest, wording, intended_scope: { kind: 'project' } })],
        }),
      })
    );

    expect(validation.validated.statements).toEqual([]);
    expect(validation.failures.map((failure) => failure.rule)).toEqual([
      'CANONICAL_REUSE_REQUIRED',
    ]);
  });

  it('does not force same wording in a different scope into an exact restatement', () => {
    const wording = 'All measurements must use two decimal places.';
    const related = existingKnowledge({
      kind: 'requirement',
      entity_id: 'requirement-precision',
      revision_id: 'requirement-precision-r2',
      text: wording,
      intended_scope: { kind: 'project' },
    });
    const manifest = manifestFor({ text: wording, related: [related] });
    const validation = accepted(
      validateProposal({
        manifest,
        answer: proposalOf(manifest, {
          statements: [statementOf({ manifest, wording })],
        }),
      })
    );

    expect(validation.failures).toEqual([]);
    expect(validation.validated.statements[0].identity).toEqual({ kind: 'new' });
  });

  it('does not treat the retrieval query scope as the target interpretation scope', () => {
    const wording = 'All measurements must use two decimal places.';
    const related = existingKnowledge({
      kind: 'requirement',
      entity_id: 'requirement-precision',
      revision_id: 'requirement-precision-r2',
      text: wording,
      intended_scope: { kind: 'artifact', artifact_id: 'artifact-from-another-task' },
    });
    const manifest = manifestFor({ text: wording, related: [related] });
    const validation = accepted(
      validateProposal({
        manifest,
        answer: proposalOf(manifest, { statements: [statementOf({ manifest, wording })] }),
      })
    );

    expect(validation.failures).toEqual([]);
    expect(validation.validated.statements[0].identity).toEqual({ kind: 'new' });
  });

  it('recognizes project scope independently of an artifact-scoped retrieval query', () => {
    const wording = 'All measurements must use two decimal places.';
    const related = existingKnowledge({
      kind: 'requirement',
      entity_id: 'requirement-precision',
      revision_id: 'requirement-precision-r2',
      text: wording,
      intended_scope: { kind: 'project' },
    });
    const manifest = manifestFor({ text: wording, related: [related] });
    const validation = accepted(
      validateProposal({
        manifest,
        answer: proposalOf(manifest, {
          statements: [statementOf({ manifest, wording, intended_scope: { kind: 'project' } })],
        }),
      })
    );

    expect(validation.validated.statements).toEqual([]);
    expect(validation.failures.map((failure) => failure.rule)).toEqual([
      'CANONICAL_REUSE_REQUIRED',
    ]);
  });

  it('does not infer a scope for a target whose retained intended scope is unknown', () => {
    const wording = 'All measurements must use two decimal places.';
    const related = existingKnowledge({
      kind: 'requirement',
      entity_id: 'requirement-precision',
      revision_id: 'requirement-precision-r2',
      text: wording,
      intended_scope: { kind: 'unknown' },
    });
    const manifest = manifestFor({ text: wording, related: [related] });
    const validation = accepted(
      validateProposal({
        manifest,
        answer: proposalOf(manifest, {
          statements: [statementOf({ manifest, wording, intended_scope: { kind: 'project' } })],
        }),
      })
    );

    expect(validation.failures).toEqual([]);
    expect(validation.validated.statements[0].identity).toEqual({ kind: 'new' });
  });

  it.each([
    ['invalid interpretation provenance', 'invalid' as const],
    ['unclassified fixture provenance', undefined],
  ])('does not trust adopted scope for %s', (_description, intendedScopeStatus) => {
    const wording = 'All measurements must use two decimal places.';
    const related = existingKnowledge({
      kind: 'requirement',
      entity_id: 'requirement-precision',
      revision_id: 'requirement-precision-r2',
      text: wording,
      intended_scope_status: intendedScopeStatus,
      scope: { kind: 'project', project_id: 'project-under-test' },
    });
    if (intendedScopeStatus === undefined) {
      delete related.statements[0].intended_scope_status;
    }
    const manifest = manifestFor({ text: wording, related: [related] });
    const validation = accepted(
      validateProposal({
        manifest,
        answer: proposalOf(manifest, {
          statements: [statementOf({ manifest, wording, intended_scope: { kind: 'project' } })],
        }),
      })
    );

    expect(validation.failures).toEqual([]);
    expect(validation.validated.statements[0].identity).toEqual({ kind: 'new' });
  });

  it('uses a legacy revision adopted in this project without using the query scope', () => {
    const wording = 'All measurements must use two decimal places.';
    const related = existingKnowledge({
      kind: 'requirement',
      entity_id: 'requirement-precision',
      revision_id: 'requirement-precision-r2',
      text: wording,
      scope: { kind: 'project', project_id: 'project-under-test' },
    });
    const manifest = manifestFor({ text: wording, related: [related] });
    const validation = accepted(
      validateProposal({
        manifest,
        answer: proposalOf(manifest, {
          statements: [statementOf({ manifest, wording, intended_scope: { kind: 'project' } })],
        }),
      })
    );

    expect(validation.validated.statements).toEqual([]);
    expect(validation.failures.map((failure) => failure.rule)).toEqual([
      'CANONICAL_REUSE_REQUIRED',
    ]);
  });

  it('does not infer a scope for a legacy unadopted revision', () => {
    const wording = 'All measurements must use two decimal places.';
    const related = existingKnowledge({
      kind: 'requirement',
      entity_id: 'requirement-precision',
      revision_id: 'requirement-precision-r2',
      text: wording,
      standing: 'unadopted',
    });
    const manifest = manifestFor({ text: wording, related: [related] });
    const validation = accepted(
      validateProposal({
        manifest,
        answer: proposalOf(manifest, { statements: [statementOf({ manifest, wording })] }),
      })
    );

    expect(validation.failures).toEqual([]);
    expect(validation.validated.statements[0].identity).toEqual({ kind: 'new' });
  });

  it('does not reuse a legacy revision adopted for a different artifact', () => {
    const wording = 'All measurements must use two decimal places.';
    const related = existingKnowledge({
      kind: 'requirement',
      entity_id: 'requirement-precision',
      revision_id: 'requirement-precision-r2',
      text: wording,
      scope: { kind: 'artifact', artifact_id: 'artifact-from-another-task' },
    });
    const manifest = manifestFor({ text: wording, related: [related] });
    const validation = accepted(
      validateProposal({
        manifest,
        answer: proposalOf(manifest, { statements: [statementOf({ manifest, wording })] }),
      })
    );

    expect(validation.failures).toEqual([]);
    expect(validation.validated.statements[0].identity).toEqual({ kind: 'new' });
  });

  it('rejects an unsupplied equivalence target without losing the statement', () => {
    const manifest = manifestFor({ text: 'Show two digits after the decimal point.' });
    const validation = accepted(
      validateProposal({
        manifest,
        answer: proposalOf(manifest, {
          statements: [
            statementOf({
              manifest,
              wording: 'Show two digits after the decimal point.',
              links: [{ revision_ref: 'k9r9', relation: 'equivalent_to' }],
            }),
          ],
        }),
      })
    );
    expect(validation.validated.statements).toHaveLength(1);
    expect(validation.validated.statements[0]).toMatchObject({
      identity: { kind: 'new' },
      links: [],
    });
    expect(validation.validated.quality).toMatchObject({
      accepted: { statements: 1 },
      rejected: { statements: 0, links: 1 },
    });
  });

  it('keeps a supported correction and rejects a sibling with a missing target', () => {
    const related = existingKnowledge({
      kind: 'claim',
      entity_id: 'claim-sync-duration',
      revision_id: 'claim-sync-duration-r1',
      text: 'The sync took 41 seconds.',
    });
    const manifest = manifestFor({ text: 'The sync took 19 seconds.', related: [related] });
    const account = quoteOf(manifest, 'The sync took 19 seconds.');
    const validation = accepted(
      validateProposal({
        manifest,
        answer: proposalOf(manifest, {
          corrections: [
            { kind: 'factual_correction', revision_ref: 'k1r1', account },
            { kind: 'factual_correction', revision_ref: 'k9r9', account },
          ],
        }),
      })
    );

    expect(validation.validated.corrections).toHaveLength(1);
    expect(validation.validated.quality).toMatchObject({
      proposed: { corrections: 2 },
      accepted: { corrections: 1 },
      rejected: { corrections: 1 },
    });
    expect(validation.failures).toContainEqual(
      expect.objectContaining({
        rule: 'REVISION_NOT_IN_MANIFEST',
        item: { kind: 'correction', index: 1 },
      })
    );
  });

  it('rejects repeated identity links without choosing one for the statement', () => {
    const related = existingKnowledge({
      kind: 'requirement',
      entity_id: 'requirement-offline',
      revision_id: 'requirement-offline-r1',
      text: 'Work offline.',
    });
    const manifest = manifestFor({ text: 'Queue writes must work offline.', related: [related] });
    const base = statementOf({
      manifest,
      wording: 'Queue writes must work offline.',
      links: [{ revision_ref: 'k1r1', relation: 'refines' }],
    });
    expect(
      accepted(validateProposal({ manifest, answer: proposalOf(manifest, { statements: [base] }) }))
        .validated.statements[0].identity
    ).toMatchObject({ kind: 'refines' });

    const competing = {
      ...base,
      links: [...base.links, { revision_ref: 'k1r1', relation: 'equivalent_to' as const }],
    };
    const validation = accepted(
      validateProposal({ manifest, answer: proposalOf(manifest, { statements: [competing] }) })
    );
    expect(validation.validated.statements).toHaveLength(1);
    expect(validation.validated.statements[0]).toMatchObject({
      identity: { kind: 'new' },
      links: [],
    });
    expect(validation.validated.quality).toMatchObject({
      accepted: { statements: 1, links: 0 },
      rejected: { statements: 0, links: 2 },
    });
    expect(validation.failures.map((failure) => failure.rule)).toEqual([
      'DUPLICATE_LINK_TARGET',
      'MULTIPLE_IDENTITY_LINKS',
    ]);
  });

  it('rejects a cross-kind identity link without losing independent wording', () => {
    const related = existingKnowledge({
      kind: 'decision',
      entity_id: 'decision-storage',
      revision_id: 'decision-storage-r1',
      text: 'Use SQLite.',
      intended_scope: { kind: 'project' },
    });
    const manifest = manifestFor({ text: 'Use SQLite.', related: [related] });
    const validation = accepted(
      validateProposal({
        manifest,
        answer: proposalOf(manifest, {
          statements: [
            statementOf({
              manifest,
              wording: 'Use SQLite.',
              intended_scope: { kind: 'project' },
              links: [{ revision_ref: 'k1r1', relation: 'exact_restatement' }],
            }),
          ],
        }),
      })
    );

    expect(validation.validated.statements).toHaveLength(1);
    expect(validation.validated.statements[0]).toMatchObject({
      identity: { kind: 'new' },
      links: [],
    });
    expect(validation.failures.map((failure) => failure.rule)).toEqual(['IDENTITY_KIND_MISMATCH']);
    expect(validation.validated.quality).toMatchObject({
      accepted: { statements: 1 },
      rejected: { statements: 0, links: 1 },
    });
  });

  it('rejects refinement from a claim while retaining an independently evidenced requirement', () => {
    const related = existingKnowledge({
      kind: 'claim',
      entity_id: 'claim-offline',
      revision_id: 'claim-offline-r1',
      text: 'Offline writes were observed.',
    });
    const manifest = manifestFor({ text: 'Queue writes must work offline.', related: [related] });
    const validation = accepted(
      validateProposal({
        manifest,
        answer: proposalOf(manifest, {
          statements: [
            statementOf({
              manifest,
              wording: 'Queue writes must work offline.',
              links: [{ revision_ref: 'k1r1', relation: 'refines' }],
            }),
          ],
        }),
      })
    );

    expect(validation.validated.statements[0]).toMatchObject({
      identity: { kind: 'new' },
      links: [],
    });
    expect(validation.failures).toEqual([
      expect.objectContaining({
        rule: 'IDENTITY_TARGET_NOT_AN_EXPECTATION',
        item: { kind: 'link', statement_index: 0, link_index: 0 },
      }),
    ]);
    expect(validation.validated.quality).toMatchObject({
      accepted: { statements: 1 },
      rejected: { statements: 0, links: 1 },
    });
  });

  it('does not promote a none statement when rejecting its identity link', () => {
    const related = existingKnowledge({
      kind: 'requirement',
      entity_id: 'requirement-sample',
      revision_id: 'requirement-sample-r1',
      text: 'Samples must be inspected.',
    });
    const manifest = manifestFor({ text: 'Inspect the sample.', related: [related] });
    const validation = accepted(
      validateProposal({
        manifest,
        answer: proposalOf(manifest, {
          statements: [
            statementOf({
              manifest,
              wording: 'Inspect the sample.',
              source_form: 'task_local_criterion',
              proposed_record: 'none',
              links: [{ revision_ref: 'k1r1', relation: 'equivalent_to' }],
            }),
          ],
        }),
      })
    );

    expect(validation.validated.statements[0]).toMatchObject({
      identity: { kind: 'none' },
      statement: { proposed_record: 'none' },
      links: [],
    });
    expect(validation.validated.quality).toMatchObject({
      accepted: { statements: 0 },
      held_back: { statements: 1 },
      rejected: { links: 1 },
    });
  });

  it('retains verbatim wording without minting a duplicate after an unknown identity link', () => {
    const wording = 'Queue writes must work offline.';
    const related = existingKnowledge({
      kind: 'requirement',
      entity_id: 'requirement-offline',
      revision_id: 'requirement-offline-r1',
      text: wording,
      intended_scope: { kind: 'artifact', artifact_id: 'artifact-offline-sync' },
    });
    const manifest = manifestFor({ text: wording, related: [related] });
    const validation = accepted(
      validateProposal({
        manifest,
        answer: proposalOf(manifest, {
          statements: [
            statementOf({
              manifest,
              wording,
              links: [{ revision_ref: 'k9r9', relation: 'exact_restatement' }],
            }),
          ],
        }),
      })
    );

    expect(validation.validated.statements).toHaveLength(1);
    expect(validation.validated.statements[0]).toMatchObject({
      identity: { kind: 'identity_unresolved' },
      links: [],
    });
    expect(validation.failures.map((failure) => failure.rule)).toEqual([
      'REVISION_NOT_IN_MANIFEST',
    ]);
    expect(validation.validated.quality).toMatchObject({
      accepted: { statements: 1 },
      rejected: { statements: 0, links: 1 },
    });
  });

  it('rejects invalid alternatives independently from their decision', () => {
    const text =
      'Use SQLite for the local queue. An in-memory queue was rejected because it loses data on restart. A remote queue adds operational overhead.';
    const manifest = manifestFor({ text });
    const valid = {
      option: 'Use an in-memory queue.',
      option_citations: [quoteOf(manifest, 'An in-memory queue')],
      rejected_because: 'It loses data on restart.',
      rejection_citations: [quoteOf(manifest, 'it loses data on restart')],
    };
    const invalid = {
      option: 'Use a remote queue.',
      option_citations: [quoteOf(manifest, 'A remote queue')],
      rejected_because: 'It is too expensive.',
      rejection_citations: [
        { ...quoteOf(manifest, 'adds operational overhead'), quote: 'It is too expensive.' },
      ],
    };
    const validation = accepted(
      validateProposal({
        manifest,
        answer: proposalOf(manifest, {
          statements: [
            statementOf({
              manifest,
              wording: 'Use SQLite for the local queue.',
              source_form: 'stated_decision',
              proposed_record: 'decision',
              alternatives: [valid, invalid],
            }),
          ],
        }),
      })
    );

    expect(validation.validated.statements).toHaveLength(1);
    expect(validation.validated.statements[0].alternatives).toHaveLength(1);
    expect(validation.validated.statements[0].alternatives[0].alternative).toMatchObject({
      option: valid.option,
      rejected_because: valid.rejected_because,
    });
    expect(validation.validated.quality).toMatchObject({
      proposed: { statements: 1, alternatives: 2 },
      accepted: { statements: 1, alternatives: 1 },
      rejected: { statements: 0, alternatives: 1 },
    });
    expect(validation.failures).toEqual([
      expect.objectContaining({
        rule: 'CITATION_NOT_FOUND',
        item: { kind: 'alternative', statement_index: 0, alternative_index: 1 },
      }),
    ]);
  });

  it('accepts an uncertainty note at the length limit', () => {
    const manifest = manifestFor({ text: 'Keep drafts.' });
    const note = 'x'.repeat(PROPOSAL_LIMITS.note_chars);
    const validation = accepted(
      validateProposal({
        manifest,
        answer: proposalOf(manifest, {
          uncertainties: [{ about: 'meaning', statement_index: null, note }],
        }),
      })
    );

    expect(validation.validated.uncertainties).toEqual([
      { about: 'meaning', statement_index: null, note },
    ]);
    expect(validation.failures).toEqual([]);
  });

  it('drops an overlong uncertainty without discarding accepted statements', () => {
    const manifest = manifestFor({ text: 'Keep drafts.' });
    const validation = accepted(
      validateProposal({
        manifest,
        answer: proposalOf(manifest, {
          statements: [statementOf({ manifest, wording: 'Keep drafts.' })],
          uncertainties: [
            {
              about: 'meaning',
              statement_index: 0,
              note: 'x'.repeat(PROPOSAL_LIMITS.note_chars + 1),
            },
          ],
        }),
      })
    );

    expect(validation.validated.statements).toHaveLength(1);
    expect(validation.validated.uncertainties).toEqual([]);
    expect(validation.failures.map((failure) => failure.rule)).toEqual([
      'UNCERTAINTY_NOTE_TOO_LONG',
    ]);
  });

  it.each([
    ['must', 'should'],
    ['all users', 'admin users'],
    ['production', 'test'],
    ['always', 'except maintenance'],
    ['within 10 seconds', 'within 30 seconds'],
    ['must retain', 'must not retain'],
  ])('does not merge near wording when %s differs from %s', (existing, proposed) => {
    const retained = `The system ${existing} preserve drafts.`;
    const wording = `The system ${proposed} preserve drafts.`;
    const manifest = manifestFor({
      text: wording,
      related: [
        existingKnowledge({
          kind: 'requirement',
          entity_id: 'requirement-drafts',
          revision_id: 'requirement-drafts-r1',
          text: retained,
        }),
      ],
    });
    const statement = accepted(
      validateProposal({
        manifest,
        answer: proposalOf(manifest, {
          statements: [
            statementOf({
              manifest,
              wording,
              links: [{ revision_ref: 'k1r1', relation: 'cannot_tell' }],
            }),
          ],
        }),
      })
    ).validated.statements[0];
    expect(statement.identity).toEqual({ kind: 'new' });
  });

  it.each(['rejected_alternative', 'rejection_reason', 'non_goal', 'non_goal_reason'] as const)(
    'does not promote a %s field into a chosen requirement',
    (role) => {
      const manifest = manifestFor({ text: 'Use a remote queue.', primary_role: role });
      const validation = accepted(
        validateProposal({
          manifest,
          answer: proposalOf(manifest, {
            statements: [statementOf({ manifest, wording: 'Use a remote queue.' })],
          }),
        })
      );
      expect(validation.validated.statements).toEqual([]);
      expect(validation.failures.map((failure) => failure.rule)).toContain(
        'SOURCE_ROLE_NOT_PROPOSABLE'
      );
    }
  );
});
