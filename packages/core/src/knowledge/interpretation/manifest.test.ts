import { describe, expect, it } from 'vitest';

import {
  interpretationSegmentId,
  interpretationUnitId,
  prepareInterpretationText,
} from '@orcaops/storage';

import { existingKnowledge } from './evaluation/knowledge.js';
import { manifestFor } from './fixture.test-support.js';
import { buildInterpretationManifest, manifestHash, manifestSegment } from './manifest.js';

describe('the frozen interpretation manifest', () => {
  it('assigns refs to ordered sources and carries only scheduled prepared ranges', () => {
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

    expect(manifest.sources.map(({ ref, source_id }) => ({ ref, source_id }))).toEqual([
      { ref: 's1', source_id: 'event-under-test#summary#0' },
      { ref: 's2', source_id: 'event-under-test#decisions[0].reason#0' },
    ]);
    expect(manifest.segments.map((segment) => [segment.source_ref, segment.text])).toEqual([
      ['s1', 'Choose SQLite here.'],
      ['s2', 'It must continue working offline.'],
    ]);
    expect(manifest.segments.map((segment) => segment.ref)).toEqual(['g1', 'g2']);
  });

  it('reproduces redaction and control removal mappings before accepting a schedule', () => {
    const secret = `ghp_${'A'.repeat(36)}`;
    const original = `keep${String.fromCharCode(0)} ${secret} keep`;
    const manifest = manifestFor({ text: original });
    const prepared = prepareInterpretationText(original);

    expect(manifest.segments[0]).toMatchObject({
      text: prepared.prepared,
      mapping_version: prepared.mappingVersion,
      mapping_sha256: prepared.mappingSha256,
      prepared_sha256: prepared.preparedSha256,
    });
    expect(manifest.segments[0].mapping.map((run) => run.kind)).toContain('removed_control');
    expect(manifest.segments[0].mapping.map((run) => run.kind)).toContain('redacted');
    expect(manifest.segments[0].text).not.toContain(secret);
  });

  it('refuses a segment whose retained mapping no longer matches its source', () => {
    const manifest = manifestFor({ text: 'Stable source.' });
    const { ref, source_ref, text, ...segment } = manifest.segments[0];
    void ref;
    void source_ref;
    void text;
    expect(() =>
      buildInterpretationManifest({
        schedule_id: manifest.schedule_id,
        unit_id: manifest.unit_id,
        project_id: manifest.project_id,
        source_event_id: manifest.source_event_id,
        task_context: manifest.task_context,
        sources: [{ source_id: segment.source_id, text: 'Changed source.' }],
        segments: [segment],
        attributed_to: manifest.attributed_to,
        knowledge_boundary: manifest.knowledge_boundary,
        related_knowledge: [],
      })
    ).toThrow('does not match deterministic preparation');
  });

  it('hashes the exact ordered scheduled unit', () => {
    const manifest = manifestFor({ text: 'Stable source.' });
    const { manifest_sha256, ...body } = manifest;
    expect(manifestHash(body)).toBe(manifest_sha256);
    expect(manifestHash({ ...body, unit_id: 'c'.repeat(64) })).not.toBe(manifest_sha256);
    expect(manifestSegment(manifest, 's1', manifest.segments[0].ref)?.text).toBe('Stable source.');
  });

  it('refuses a unit ID that does not hash the ordered scheduled segments', () => {
    const manifest = manifestFor({ text: 'Stable source.' });
    const { ref, source_ref, text, ...segment } = manifest.segments[0];
    void ref;
    void source_ref;
    void text;
    expect(() =>
      buildInterpretationManifest({
        schedule_id: manifest.schedule_id,
        unit_id: 'f'.repeat(64),
        project_id: manifest.project_id,
        source_event_id: manifest.source_event_id,
        task_context: manifest.task_context,
        sources: [{ source_id: segment.source_id, text: 'Stable source.' }],
        segments: [segment],
        attributed_to: manifest.attributed_to,
        knowledge_boundary: manifest.knowledge_boundary,
        related_knowledge: [],
      })
    ).toThrow('unit ID does not match');
  });

  it('indexes retained wording and intended scope under one exact revision ref', () => {
    const manifest = manifestFor({
      text: 'Use the existing rule.',
      related: [
        existingKnowledge({
          kind: 'requirement',
          entity_id: 'requirement-offline',
          revision_id: 'requirement-offline-r1',
          text: 'The queue must work offline.',
          intended_scope: { kind: 'project' },
        }),
      ],
    });

    expect(manifest.revisions).toEqual([
      expect.objectContaining({
        ref: 'k1r1',
        statement: 'The queue must work offline.',
        intended_scope: { kind: 'project' },
        intended_scope_status: 'verified',
      }),
    ]);
  });

  it('gives separate references to disjoint segments of the same source', () => {
    const sourceText = 'Keep drafts. Retry later.';
    const original = manifestFor({ text: sourceText });
    const {
      ref: _ref,
      source_ref: _sourceRef,
      text: _text,
      segment_id: _id,
      ...identity
    } = original.segments[0];
    const segments = [
      { start: 0, end: 12 },
      { start: 13, end: 25 },
    ].map((prepared_range) => {
      const segment = { ...identity, prepared_range };
      return { ...segment, segment_id: interpretationSegmentId(segment) };
    });
    const manifest = buildInterpretationManifest({
      ...original,
      unit_id: interpretationUnitId(segments),
      sources: [{ source_id: identity.source_id, text: sourceText }],
      segments,
      related_knowledge: [],
    });
    expect(manifest.segments.map(({ ref, source_ref }) => [ref, source_ref])).toEqual([
      ['g1', 's1'],
      ['g2', 's1'],
    ]);
    expect(manifestSegment(manifest, 's1', 'g2')?.text).toBe('Retry later.');
    expect(manifestSegment(manifest, 's2', 'g2')).toBeNull();
    expect(manifestSegment(manifest, 's1', segments[1]!.segment_id)).toBeNull();
    expect(manifestSegment(manifest, 's1', 'g02')).toBeNull();
    const { manifest_sha256, ...body } = manifest;
    expect(manifestHash({ ...body, segments: [...manifest.segments].reverse() })).not.toBe(
      manifest_sha256
    );
  });

  it('omits an unreadable related revision instead of inventing its wording', () => {
    const related = existingKnowledge({
      kind: 'requirement',
      entity_id: 'requirement-offline',
      revision_id: 'requirement-offline-r1',
      text: 'The queue must work offline.',
    });
    const manifest = manifestFor({
      text: 'Use the existing rule.',
      related: [{ ...related, statements: [] }],
    });

    expect(manifest.revisions).toEqual([]);
    expect(manifest.coverage_limits).toContainEqual(
      expect.objectContaining({ kind: 'related_statement_missing' })
    );
  });
});
