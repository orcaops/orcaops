import { describe, expect, it } from 'vitest';

import {
  IntendedScopeSchema,
  interpretationProposalJsonSchema,
  InterpretationProposalSchema,
  PROPOSAL_LIMITS,
  ProposedRationaleSchema,
  ProposedRecordSchema,
  RECORD_ALLOWED_FOR_SOURCE_FORM,
  SourceFormSchema,
} from './proposal.js';
import { PROPOSAL_SCHEMA_VERSION } from './versions.js';

const citation = { source_ref: 's1', segment_ref: 'g1', quote: 'Use SQLite.' };
const statement = {
  source_ref: 's1',
  wording: 'Use SQLite for the local queue.',
  source_form: 'stated_decision',
  proposed_record: 'decision',
  intended_scope: { kind: 'project' },
  evidence: [citation],
  rationale: { kind: 'unknown' },
  alternatives: [],
  links: [{ revision_ref: 'k1r1', relation: 'equivalent_to' }],
};
const proposal = {
  proposal_schema_version: PROPOSAL_SCHEMA_VERSION,
  manifest_sha256: 'b'.repeat(64),
  statements: [statement],
  corrections: [],
  uncertainties: [],
};

function expandedProviderSchema(): Record<string, unknown> {
  const root = interpretationProposalJsonSchema();
  const expand = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(expand);
    if (value === null || typeof value !== 'object') return value;
    const node = value as Record<string, unknown>;
    if (typeof node.$ref === 'string') {
      expect(node.$ref).toMatch(/^#\/definitions\/[^/]+$/u);
      const target = (root.definitions as Record<string, unknown>)[node.$ref.split('/')[2]!];
      expect(target).toBeDefined();
      return expand(target);
    }
    return Object.fromEntries(Object.entries(node).map(([key, child]) => [key, expand(child)]));
  };
  return expand(root) as Record<string, unknown>;
}

describe('the interpretation proposal schema', () => {
  it('accepts interpretation wording that differs from its exact evidence quote', () => {
    expect(InterpretationProposalSchema.safeParse(proposal).success).toBe(true);
  });

  it('represents an unstated rationale explicitly', () => {
    expect(statement.rationale).toEqual({ kind: 'unknown' });
  });

  it('requires separately cited decision alternatives', () => {
    const alternative = {
      option: 'Use an in-memory queue.',
      option_citations: [citation],
      rejected_because: 'It would not survive a restart.',
      rejection_citations: [citation],
    };
    expect(
      InterpretationProposalSchema.safeParse({
        ...proposal,
        statements: [{ ...statement, alternatives: [alternative] }],
      }).success
    ).toBe(true);
    const { rejection_citations: _omitted, ...uncitedReason } = alternative;
    expect(
      InterpretationProposalSchema.safeParse({
        ...proposal,
        statements: [{ ...statement, alternatives: [uncitedReason] }],
      }).success
    ).toBe(false);
  });

  it.each(['authorization', 'adopted', 'designation', 'approved_by', 'actor'])(
    'has no place for authority field %s',
    (field) => {
      expect(
        InterpretationProposalSchema.safeParse({
          ...proposal,
          statements: [{ ...statement, [field]: 'owner' }],
        }).success
      ).toBe(false);
    }
  );

  it('requires citations to name a supplied-source ref and segment, never offsets', () => {
    expect(
      InterpretationProposalSchema.safeParse({
        ...proposal,
        statements: [{ ...statement, evidence: [{ start: 0, end: 3, quote: 'Use' }] }],
      }).success
    ).toBe(false);
  });

  it('uses claim as the retained observation record kind', () => {
    expect(RECORD_ALLOWED_FOR_SOURCE_FORM.observation).toEqual(['claim', 'none']);
    expect(RECORD_ALLOWED_FOR_SOURCE_FORM.test_or_check).toEqual(['claim', 'none']);
  });

  it('keeps scope and rationale branches strict and mutually exclusive', () => {
    for (const scope of [{ kind: 'project' }, { kind: 'current_task' }, { kind: 'unknown' }]) {
      expect(IntendedScopeSchema.safeParse(scope).success).toBe(true);
    }
    for (const scope of [
      { kind: 'artifact' },
      { kind: 'artifact', artifact_id: 'task-a' },
      { kind: 'current_task', artifact_id: 'task-a' },
      { kind: 'project', artifact_id: 'task-a' },
      { kind: 'unknown', artifact_id: 'task-a' },
    ]) {
      expect(IntendedScopeSchema.safeParse(scope).success).toBe(false);
    }
    expect(ProposedRationaleSchema.safeParse({ kind: 'unknown' }).success).toBe(true);
    expect(
      ProposedRationaleSchema.safeParse({
        kind: 'stated',
        wording: 'It works offline.',
        citations: [citation],
      }).success
    ).toBe(true);
    expect(ProposedRationaleSchema.safeParse({ kind: 'stated' }).success).toBe(false);
    expect(
      ProposedRationaleSchema.safeParse({ kind: 'unknown', wording: 'Invented.' }).success
    ).toBe(false);
  });
});

describe('the provider JSON schema', () => {
  it('allows exactly the source form and record pairs accepted by semantic validation', () => {
    const schema = expandedProviderSchema() as {
      properties: {
        statements: {
          items: {
            anyOf: {
              properties: { source_form: { const: string }; proposed_record: { enum: string[] } };
            }[];
          };
        };
      };
    };
    for (const sourceForm of SourceFormSchema.options) {
      for (const record of ProposedRecordSchema.options) {
        const allowed = RECORD_ALLOWED_FOR_SOURCE_FORM[sourceForm].includes(record);
        const matches = schema.properties.statements.items.anyOf.filter(
          (branch) =>
            branch.properties.source_form.const === sourceForm &&
            branch.properties.proposed_record.enum.includes(record)
        );
        expect(matches).toHaveLength(allowed ? 1 : 0);
        expect(
          InterpretationProposalSchema.safeParse({
            ...proposal,
            statements: [{ ...statement, source_form: sourceForm, proposed_record: record }],
          }).success
        ).toBe(allowed);
      }
    }
  });

  it('uses the accepted uncertainty note limit for constrained generation', () => {
    expect(expandedProviderSchema()).toMatchObject({
      properties: {
        uncertainties: {
          items: { properties: { note: { maxLength: PROPOSAL_LIMITS.note_chars } } },
        },
      },
    });
  });

  it('emits anyOf for scope and rationale without unsupported oneOf anywhere', () => {
    const schema = expandedProviderSchema();
    expect(schema).toMatchObject({
      properties: {
        statements: {
          items: {
            anyOf: expect.arrayContaining([
              expect.objectContaining({
                properties: expect.objectContaining({
                  intended_scope: { anyOf: expect.any(Array) },
                  rationale: { anyOf: expect.any(Array) },
                }),
              }),
            ]),
          },
        },
      },
    });
    const visit = (value: unknown): void => {
      if (value === null || typeof value !== 'object') return;
      expect(value).not.toHaveProperty('oneOf');
      for (const child of Object.values(value)) visit(child);
    };
    visit(schema);
    expect(JSON.stringify(schema)).not.toContain('artifact_id');
  });

  it('makes every provider object closed with all properties required', () => {
    const visit = (value: unknown): void => {
      if (value === null || typeof value !== 'object') return;
      const schema = value as Record<string, unknown>;
      if (schema.type === 'object') {
        expect(schema.additionalProperties).toBe(false);
        const properties = schema.properties as Record<string, unknown>;
        expect([...(schema.required as string[])].sort()).toEqual(Object.keys(properties).sort());
      }
      for (const child of Object.values(schema)) visit(child);
    };

    visit(interpretationProposalJsonSchema());
  });

  it('declares draft-07, the JSON Schema dialect the claude CLI accepts', () => {
    const schema = interpretationProposalJsonSchema();
    expect(schema.$schema).toBe('http://json-schema.org/draft-07/schema#');
    expect(schema).toHaveProperty('definitions');
  });

  it('is generated from the strict proposal schema and returned by copy', () => {
    const schema = interpretationProposalJsonSchema();
    expect(schema.additionalProperties).toBe(false);
    (schema as { type?: unknown }).type = 'tampered';
    expect(interpretationProposalJsonSchema().type).toBe('object');
  });

  it('binds each request hash without changing the cached schema or another request', () => {
    const first = interpretationProposalJsonSchema('a'.repeat(64));
    const second = interpretationProposalJsonSchema('b'.repeat(64));
    expect(first).toMatchObject({ properties: { manifest_sha256: { const: 'a'.repeat(64) } } });
    expect(second).toMatchObject({ properties: { manifest_sha256: { const: 'b'.repeat(64) } } });
    expect(
      (interpretationProposalJsonSchema().properties as Record<string, unknown>).manifest_sha256
    ).not.toHaveProperty('const');
  });
});
