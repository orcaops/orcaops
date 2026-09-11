import { describe, expect, it } from 'vitest';

import { uuidv7 } from '../../ids/uuidv7.js';
import { digest } from '../event-integrity.js';
import {
  prepareImportedProjectSeedBundle,
  prepareProjectSeedBundle,
  seedBundlePreparation,
  type SeedBundleSource,
} from './seed-bundle-input.js';
import {
  prepareImportedProjectSeedState,
  prepareProjectSeedState,
  seedStatePreparation,
  type SeedStateSource,
} from './seed-state-input.js';

const at = '2026-09-05T00:00:00.000Z';
const nonce = 'a'.repeat(32);
function precious() {
  return {
    schema_version: 1,
    install_nonce: nonce,
    pr_context: true,
    pending_importance: false,
    commit_graph_hint_shown: false,
    discovery_areas: { src: { declined_at: null }, tests: {} },
    updated_at: at,
  };
}
function journal() {
  return {
    schema_version: 2,
    install_nonce: nonce,
    options_hash: 'options',
    updated_at: at,
    clusters: { cluster: { artifact_id: 'original-artifact', status: 'writing' } },
    jobs: {
      'original-job': {
        kind: 'resume',
        started_at: at,
        invoked_by: 'codex',
        budget: { max_commits: 20, selected_commits: 2 },
      },
    },
  };
}
function source(bytes: Uint8Array) {
  const sourceId = uuidv7();
  return {
    sourceId,
    sourceIdentity: 'original-source',
    sourceLocation: sourceId,
    sourceRevisionId: 'original-revision',
    sourceOperationId: 'original-operation',
    sourceSha256: digest(Buffer.from(bytes)),
    bytes,
  };
}
function stateSource(kind: SeedStateSource['kind'], value: unknown): SeedStateSource {
  return { ...source(Buffer.from('  ' + JSON.stringify(value) + '\n')), kind };
}
function request() {
  return { operationId: uuidv7(), revisionId: uuidv7(), expectedRevision: null, secretAllow: [] };
}
function enrichment(changes: Record<string, unknown> = {}) {
  return {
    schema_version: 2,
    cluster_key: 'cluster',
    options_hash: 'options',
    used_pr_context: false,
    label: 'Original label',
    task: 'Original task',
    steps: [{ label: 'Change', text: 'Original change' }],
    checkpoint_summaries: ['Original checkpoint'],
    outcome: 'Original outcome',
    decisions: [],
    ...changes,
  };
}
function bundleSource(key: string, value: unknown): SeedBundleSource {
  return {
    ...source(Buffer.from(typeof value === 'string' ? value : JSON.stringify(value))),
    key,
  };
}
function bundle() {
  const artifactId = uuidv7();
  const manifest = {
    schema_version: 2,
    options_hash: 'options',
    bundles: [
      {
        filename: 'cluster.md',
        artifact_id: artifactId,
        cluster_key: 'cluster',
        kind: 'run',
        label: 'Cluster',
        date: at,
        commit_count: 1,
        checkpoint_count: 1,
        warnings: [],
        nomination_count: 0,
        distinct_task_count: 1,
      },
    ],
  };
  return {
    artifactId,
    manifest,
    sources: [
      bundleSource('manifest', manifest),
      bundleSource('bundle:cluster.md', '# Original\n'),
    ],
  };
}
function invalid(run: () => unknown) {
  expect(run).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
}
describe('seed state preparation', () => {
  it('detaches original bytes and mutable inputs while preserving source and job identities', () => {
    const p = stateSource('precious', precious());
    const j = stateSource('journal', journal());
    const input = { ...request(), sources: [p, j] };
    const prepared = prepareProjectSeedState(input);
    const value = seedStatePreparation(prepared, 'authored');
    const original = Buffer.from(p.bytes);
    p.bytes.fill(0);
    input.operationId = uuidv7();
    input.sources.length = 0;
    expect(Buffer.from(value.sources[0]!.bytes, 'base64')).toEqual(original);
    expect(value.sources[0]).toMatchObject({
      sourceRevisionId: 'original-revision',
      sourceOperationId: 'original-operation',
    });
    expect(value.view.journal?.jobs['original-job']?.kind).toBe('resume');
    expect(value.view.precious?.discovery_areas.src?.declined_at).toBeNull();
    expect(value.view.precious?.discovery_areas.tests).toEqual({});
    expect(Object.isFrozen(value.view.journal?.jobs)).toBe(true);
    expect(() => {
      value.sources.length = 0;
    }).toThrow();
    invalid(() => seedStatePreparation({} as never, 'authored'));
  });
  it('retains identical original occurrences without choosing a timestamp winner', () => {
    const original = stateSource('precious', precious());
    const repeated = { ...source(Buffer.from(original.bytes)), kind: 'precious' as const };
    const prepared = prepareImportedProjectSeedState({
      ...request(),
      sourceManifestIdentity: 'manifest',
      sources: [original, repeated],
    });
    const value = seedStatePreparation(prepared, 'historical');
    expect(value.sources).toHaveLength(2);
    expect(value.selected.precious).toBe(original.sourceId);
    expect(value.sources.map((item) => item.sourceId)).toEqual([
      original.sourceId,
      repeated.sourceId,
    ]);
    invalid(() =>
      prepareImportedProjectSeedState({
        ...request(),
        sourceManifestIdentity: 'manifest',
        sources: [original, stateSource('precious', { ...precious(), pending_importance: true })],
      })
    );
    invalid(() => seedStatePreparation(prepared, 'authored'));
  });
  it('derives journal identity and unknown decline time without rewriting the v1 source', () => {
    const legacy = {
      schema_version: 1,
      install_nonce: nonce,
      options_hash: 'original-options',
      updated_at: at,
      clusters: {},
      pr_context: false,
      pending_importance: true,
      declined_discovery_areas: [' ./src/ ', 'tests\\unit/'],
    };
    const original = stateSource('journal', legacy);
    const prepared = prepareImportedProjectSeedState({
      ...request(),
      sourceManifestIdentity: 'manifest',
      sources: [original],
    });
    const value = seedStatePreparation(prepared, 'historical');
    expect(value.view.legacyJournal).toEqual(legacy);
    expect(value.view.precious?.discovery_areas).toEqual({
      src: { declined_at: null },
      'tests/unit': { declined_at: null },
    });
    expect(value.view.journal?.jobs).toEqual({});
    expect(value.view.completeness.complete).toBe(true);
    expect(Buffer.from(value.sources[0]!.bytes, 'base64')).toEqual(original.bytes);
    expect(value.selected.precious).toBeNull();
  });
  it('preserves missing install identity and incomplete original coverage', () => {
    const coverage = stateSource('coverage', {
      schema_version: 1,
      branch_sha: 'a'.repeat(40),
      generated_at: at,
      complete: false,
      directories: {},
    });
    const value = seedStatePreparation(
      prepareProjectSeedState({
        ...request(),
        sources: [stateSource('journal', journal()), coverage],
      }),
      'authored'
    );
    expect(value.view.precious).toBeNull();
    expect(value.view.coverage?.complete).toBe(false);
    expect(value.view.completeness).toEqual({
      complete: false,
      issues: ['Original seed install identity is unavailable'],
    });
    expect(
      seedStatePreparation(prepareProjectSeedState({ ...request(), sources: [] }), 'authored').view
        .completeness.complete
    ).toBe(true);
  });
  it('rejects conflicting nonce, duplicate occurrence and incorrect original hash', () => {
    const p = stateSource('precious', precious());
    invalid(() =>
      prepareProjectSeedState({
        ...request(),
        sources: [p, stateSource('journal', { ...journal(), install_nonce: 'b'.repeat(32) })],
      })
    );
    invalid(() => prepareProjectSeedState({ ...request(), sources: [p, p] }));
    invalid(() =>
      prepareProjectSeedState({ ...request(), sources: [{ ...p, sourceSha256: '0'.repeat(64) }] })
    );
  });
  it.each([false, true])(
    'refuses concealed authored duplicate JSON strings with escaping %s',
    (escaped) => {
      const token = 'ghp_' + 'A'.repeat(36);
      const value = escaped
        ? Array.from(token)
            .map((c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)
            .join('')
        : token;
      const body = JSON.stringify(journal()).replace(
        '"options_hash":"options"',
        `"options_hash":"${value}","options_hash":"options"`
      );
      const original = { ...source(Buffer.from(body)), kind: 'journal' as const };
      expect(() => prepareProjectSeedState({ ...request(), sources: [original] })).toThrow(
        expect.objectContaining({ code: 'SECRET_IN_PAYLOAD' })
      );
      const historic = seedStatePreparation(
        prepareImportedProjectSeedState({
          ...request(),
          sourceManifestIdentity: 'manifest',
          sources: [original],
        }),
        'historical'
      );
      expect(Buffer.from(historic.sources[0]!.bytes, 'base64')).toEqual(original.bytes);
    }
  );
  it('requires explicit supported inputs and safe expected revision values', () => {
    invalid(() =>
      prepareProjectSeedState({
        ...request(),
        expectedRevision: {
          revisionId: uuidv7(),
          generation: Number.MAX_SAFE_INTEGER + 1,
          contentHash: 'a'.repeat(64),
        },
        sources: [],
      })
    );
    invalid(() =>
      prepareProjectSeedState({
        ...request(),
        sources: [stateSource('precious', { ...precious(), unrecognized: true })],
      })
    );
    const malformed = { ...source(Buffer.from([0xff])), kind: 'precious' as const };
    invalid(() =>
      prepareImportedProjectSeedState({
        ...request(),
        sourceManifestIdentity: 'manifest',
        sources: [malformed],
      })
    );
  });
});
describe('seed bundle preparation', () => {
  it('retains matching, unmatched and rejected authoring without establishing acceptance', () => {
    const b = bundle();
    const sources = [
      ...b.sources,
      bundleSource('authored:matching.json', enrichment()),
      bundleSource('authored:unmatched.json', enrichment({ cluster_key: 'other' })),
    ];
    const original = prepareProjectSeedBundle({
      ...request(),
      identity: { kind: 'pending' },
      sources,
    });
    const selected = seedBundlePreparation(original, 'authored');
    expect(selected.bundleKey).toBe('["pending",null]');
    expect(selected.view.authored.map((a) => [a.selection, a.acceptance])).toEqual([
      ['matching', 'not-established'],
      ['unmatched', 'not-established'],
    ]);
    sources.push(
      bundleSource('authored:rejected.json', enrichment({ options_hash: 'different', steps: [] }))
    );
    const rejected = seedBundlePreparation(
      prepareProjectSeedBundle({ ...request(), identity: { kind: 'pending' }, sources }),
      'authored'
    );
    expect(rejected.view.authored[0]?.reasons).toEqual(['duplicate-cluster']);
    expect(rejected.view.authored[2]?.reasons).toEqual([
      'duplicate-cluster',
      'options-mismatch',
      'checkpoint-count-mismatch',
    ]);
    expect(rejected.sources).toHaveLength(sources.length);
    expect(selected.sources).toHaveLength(4);
  });
  it('preserves original accepted fields and exact amendment targets', () => {
    const b = bundle();
    const original = enrichment();
    const value = seedBundlePreparation(
      prepareImportedProjectSeedBundle({
        ...request(),
        sourceManifestIdentity: 'manifest',
        identity: { kind: 'accepted', artifactId: b.artifactId },
        sources: [
          bundleSource('enrichment', { ...original, enriched_at: at }),
          bundleSource('authored', original),
        ],
      }),
      'historical'
    );
    expect(value.view.enrichment?.enriched_at).toBe(at);
    expect(value.identity).toEqual({ kind: 'accepted', artifactId: b.artifactId });
    const amendment = {
      artifact_id: b.artifactId,
      prior_enrichment_event_id: null,
      member_shas_hash: 'a'.repeat(64),
      decision_mode: 'preserve',
      pr_context_consented: false,
    };
    const amend = prepareProjectSeedBundle({
      ...request(),
      identity: { kind: 'amend', artifactId: b.artifactId },
      sources: [bundleSource('manifest', { ...b.manifest, amendment }), b.sources[1]!],
    });
    expect(seedBundlePreparation(amend, 'authored').view.manifest?.amendment).toEqual(amendment);
    invalid(() => seedBundlePreparation(value as never, 'authored'));
  });
  it('refuses missing, unsafe or mismatched bundle members and retired envelopes', () => {
    const b = bundle();
    const input = { ...request(), identity: { kind: 'pending' as const }, sources: b.sources };
    invalid(() => prepareProjectSeedBundle({ ...input, sources: [b.sources[0]!] }));
    invalid(() =>
      prepareProjectSeedBundle({ ...input, sources: [...b.sources, bundleSource('workspace', {})] })
    );
    invalid(() =>
      prepareProjectSeedBundle({
        ...input,
        sources: [...b.sources, bundleSource('authored:../unsafe.json', enrichment())],
      })
    );
    invalid(() =>
      prepareProjectSeedBundle({ ...input, identity: { kind: 'amend', artifactId: b.artifactId } })
    );
    invalid(() =>
      prepareProjectSeedBundle({
        ...input,
        identity: { kind: 'pending', artifactId: b.artifactId } as never,
      })
    );
    invalid(() =>
      prepareProjectSeedBundle({
        ...request(),
        identity: { kind: 'accepted', artifactId: b.artifactId },
        sources: [
          bundleSource('enrichment', { ...enrichment(), enriched_at: at }),
          bundleSource('authored', enrichment({ outcome: 'Changed' })),
        ],
      })
    );
  });
  it('refuses authored markdown and provenance secrets but retains historical originals', () => {
    const token = 'ghp_' + 'A'.repeat(36);
    const b = bundle();
    const sources = [b.sources[0]!, bundleSource('bundle:cluster.md', `# Evidence\n${token}`)];
    expect(() =>
      prepareProjectSeedBundle({ ...request(), identity: { kind: 'pending' }, sources })
    ).toThrow(expect.objectContaining({ code: 'SECRET_IN_PAYLOAD' }));
    const historical = prepareImportedProjectSeedBundle({
      ...request(),
      sourceManifestIdentity: 'manifest',
      identity: { kind: 'pending' },
      sources,
    });
    expect(
      Buffer.from(seedBundlePreparation(historical, 'historical').sources[1]!.bytes, 'base64')
    ).toEqual(sources[1]!.bytes);
    invalid(() => seedBundlePreparation(historical, 'authored'));
    expect(() =>
      prepareProjectSeedBundle({
        ...request(),
        identity: { kind: 'pending' },
        sources: [{ ...b.sources[0]!, sourceLocation: token }, b.sources[1]!],
      })
    ).toThrow(expect.objectContaining({ code: 'SECRET_IN_PAYLOAD' }));
  });
});
