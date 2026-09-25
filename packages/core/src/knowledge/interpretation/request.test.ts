import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import type { PreparedInputRequestParts } from '@orcaops/llm';

import { existingKnowledge } from './evaluation/knowledge.js';
import { manifestFor } from './fixture.test-support.js';
import {
  buildInterpretationRequest,
  planInterpretationRequest,
  smallestProcessableInputBytes,
} from './request.js';
import { relatedKnowledgeCeilingBytes } from './retrieval.js';

const provider = { name: 'fixture' } as never;
const measure = {
  measurePreparedInputRequest(parts: PreparedInputRequestParts) {
    return { bytes: Buffer.byteLength(parts.preparedInput, 'utf8') + 100 } as never;
  },
};

describe('the interpretation request', () => {
  it.each(['codex', 'claude'] as const)(
    'binds the exact instructions sent to %s to the retained manifest',
    (provider) => {
      const manifest = manifestFor({ text: 'The delivery check passed.' });
      const request = buildInterpretationRequest(manifest, { provider, measure });
      const sentInstructions = `${request.parts.systemPrompt}\n\n${request.parts.instructions}`;
      const instructionsHash = createHash('sha256').update(sentInstructions).digest('hex');

      expect(manifest.instructions_sha256).toBe(instructionsHash);
      expect(request.parts.preparedInput).toContain(`instructions: ${instructionsHash}`);
      expect(request.parts.outputSchema).toMatchObject({
        properties: { manifest_sha256: { const: manifest.manifest_sha256 } },
      });
    }
  );

  it('renders every scheduled segment with its exact source and segment references', () => {
    const manifest = manifestFor({
      text: 'Choose SQLite.',
      additional_sources: [
        {
          source_id: 'event-under-test#reason#0',
          text: 'It works offline.',
          field_path: 'reason',
          role: 'reason',
          purpose: 'context',
        },
      ],
    });
    const request = buildInterpretationRequest(manifest, { provider, measure });
    expect(request.parts.preparedInput).toContain(`source_ref: s1`);
    expect(request.parts.preparedInput).toContain(`segment_ref: ${manifest.segments[0].ref}`);
    expect(request.parts.preparedInput).toContain(`source_ref: s2`);
    expect(request.parts.preparedInput).toContain('Choose SQLite.');
    expect(request.parts.preparedInput).toContain('It works offline.');
  });

  it('renders fallible interpreted scope separately from recorded adoption scope', () => {
    const manifest = manifestFor({
      text: 'Use the same rule.',
      related: [
        existingKnowledge({
          kind: 'requirement',
          entity_id: 'requirement-project-wide',
          revision_id: 'requirement-project-wide-r1',
          text: 'Use the same rule.',
          intended_scope: { kind: 'project' },
        }),
      ],
    });
    const request = buildInterpretationRequest(manifest, { provider, measure });
    expect(request.parts.preparedInput).toContain(
      'model-interpreted intended scope: {"kind":"project"}'
    );
    expect(request.parts.preparedInput).toContain(
      'scope context: linked interpretation record integrity verified; semantic scope remains fallible'
    );
    expect(request.parts.preparedInput).toContain('recorded adoption scope: {"kind":"project"');
  });

  it('distinguishes planned criteria, completion evidence and verification without changing retained segments', () => {
    const manifest = manifestFor({
      text: 'The importer now rejects malformed rows.',
      additional_sources: [
        {
          source_id: 'planned',
          text: 'Reject malformed rows.',
          field_path: 'plan_steps.0.acceptance_criteria.0.text',
          role: 'criterion',
        },
        {
          source_id: 'completed',
          text: 'The importer rejects malformed rows.',
          field_path: 'done_criteria.0.evidence',
          role: 'criterion',
        },
        {
          source_id: 'output',
          text: 'All passed.',
          field_path: 'verification.0.output_digest',
          role: 'observation',
        },
        {
          source_id: 'written',
          text: 'Malformed-row tests were added.',
          field_path: 'tests_written.0',
          role: 'observation',
        },
        {
          source_id: 'run',
          text: 'Eight importer tests passed.',
          field_path: 'tests_run.0',
          role: 'observation',
        },
      ],
    });
    const retained = structuredClone(manifest);
    const { parts } = buildInterpretationRequest(manifest, { provider, measure });
    for (const [path, context] of [
      ['plan_steps.0.acceptance_criteria.0.text', 'planned acceptance criterion'],
      ['done_criteria.0.evidence', 'reported checkpoint completion evidence'],
      ['verification.0.output_digest', 'reported command output'],
      ['tests_written.0', 'reported tests written'],
      ['tests_run.0', 'reported tests run'],
    ]) {
      expect(parts.preparedInput).toContain(`field: "${path}"\nfield context: ${context}`);
    }
    expect(manifest).toEqual(retained);
  });

  it('labels extracted wording and classification as suggestions rather than verified facts', () => {
    const manifest = manifestFor({
      text: 'The inspection service is still planned.',
      related: [
        existingKnowledge({
          kind: 'claim',
          entity_id: 'inspection-claim',
          revision_id: 'inspection-claim-r1',
          text: 'All deliveries are inspected.',
          source_standing: 'extracted_candidate',
        }),
      ],
    });
    const request = buildInterpretationRequest(manifest, { provider, measure });
    expect(request.parts.preparedInput).toContain(
      'unverified model suggestion: wording and record kind may be wrong'
    );
    expect(request.parts.preparedInput).toContain('"All deliveries are inspected."');
  });

  it('points out supplied qualifications without changing their evidence or assigning meaning', () => {
    const manifest = manifestFor({
      text: 'The shipment inspection service follows the delivery contract.',
      additional_sources: [
        {
          source_id: 'event-under-test#uncertainty.0#0',
          text: 'Every shipment must pass inspection; the inspection service is not built yet.',
          field_path: 'uncertainty.0',
          role: 'uncertainty',
        },
        {
          source_id: 'event-under-test#open_items.0#0',
          text: 'Run the inspection service against actual deliveries.',
          field_path: 'open_items.0',
          role: 'open_item',
        },
      ],
    });
    const snapshot = structuredClone(manifest);
    const request = buildInterpretationRequest(manifest, { provider, measure });
    const input = request.parts.preparedInput;
    expect(input).toContain('a summary does not override a qualification elsewhere in this unit');
    expect(input).toContain(
      'These references identify supplied fields, not a judgment of their meaning'
    );
    for (const segment of manifest.segments.slice(1)) {
      expect(input).toContain(
        `- ${segment.source_ref} ${segment.ref}: ${JSON.stringify(segment.occurrence.field_path)}`
      );
      expect(input.split(segment.text)).toHaveLength(2);
    }
    expect(manifest).toEqual(snapshot);
  });

  it('does not invent qualification references when none were scheduled', () => {
    const manifest = manifestFor({ text: 'The delivery check passed.' });
    const request = buildInterpretationRequest(manifest, { provider, measure });
    expect(request.parts.preparedInput).not.toContain('### Qualifications and unfinished work');
  });

  it.each([
    {
      status: 'legacy_absent' as const,
      context: 'no retained model interpretation (legacy or non-model record)',
    },
    {
      status: 'invalid' as const,
      context: 'interpretation provenance invalid; do not infer intended scope',
    },
  ])('does not present $status scope provenance as a model judgment', ({ status, context }) => {
    const manifest = manifestFor({
      text: 'Keep the existing format.',
      related: [
        existingKnowledge({
          kind: 'requirement',
          entity_id: `requirement-${status}`,
          revision_id: `requirement-${status}-r1`,
          text: 'Keep the existing format.',
          intended_scope_status: status,
        }),
      ],
    });
    const request = buildInterpretationRequest(manifest, { provider, measure });
    expect(request.parts.preparedInput).toContain('model-interpreted intended scope: unavailable');
    expect(request.parts.preparedInput).toContain(`scope context: ${context}`);
    expect(request.parts.preparedInput).toContain('recorded adoption scope: {"kind":"project"');
  });

  it('never renders original secret text from a prepared source', () => {
    const secret = 'ghp_123456789012345678901234567890123456';
    const manifest = manifestFor({ text: `Token ${secret} must not leak.` });
    const request = buildInterpretationRequest(manifest, { provider, measure });
    expect(request.parts.preparedInput).not.toContain(secret);
    expect(request.parts.preparedInput).toContain('[REDACTED_SECRET]');
  });

  it('refuses an oversized frozen unit without rechunking it', () => {
    const manifest = manifestFor({ text: 'A retained unit stays intact.' });
    const request = buildInterpretationRequest(manifest, { provider, measure });
    expect(
      planInterpretationRequest(manifest, {
        provider,
        measure,
        maxInputBytes: request.bytes - 1,
      })
    ).toMatchObject({ status: 'too_large', bytes: request.bytes });
  });

  it('includes the scheduler knowledge reservation in the minimum input allowance', () => {
    let overhead = 0;
    const minimum = smallestProcessableInputBytes({
      provider,
      measure: {
        measurePreparedInputRequest(parts) {
          overhead = Buffer.byteLength(parts.preparedInput, 'utf8') + 100;
          return measure.measurePreparedInputRequest(parts);
        },
      },
    });
    expect(overhead).toBeGreaterThan(0);
    expect(
      overhead + relatedKnowledgeCeilingBytes({ max_input_bytes: minimum })
    ).toBeLessThanOrEqual(minimum);
    expect(
      overhead + relatedKnowledgeCeilingBytes({ max_input_bytes: minimum - 1 })
    ).toBeGreaterThan(minimum - 1);
  });
});
