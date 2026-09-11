import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  assertDecodedLegacyOperationalBundle,
  decodeLegacyOperationalBundle,
  type LegacyOperationalMember,
} from './operational-bundle.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const encode = (value: unknown) => Buffer.from(JSON.stringify(value) + '\n');
const at = '2026-07-23T10:00:00.000Z';
const scope = { base_url: 'HTTPS://Cloud.Example:443/', org_id: 'org-1' };
const ns = hash('https://cloud.example|org-1');
const sourceError = expect.objectContaining({ code: 'SOURCE_INTEGRITY' });
const missingError = expect.objectContaining({ code: 'SOURCE_UNAVAILABLE' });
const artifactId = '01981808-9400-7000-8000-000000000001';
const body = '# Retained sensitive plan\n';
const pull = {
  schema_version: 1,
  external_id: 'plan-1',
  slug: 'retained-plan',
  version_number: 2,
  title: 'Retained plan',
  body,
  content_hash: hash(body),
  source_ref: null,
  pulled_at: at,
  ...scope,
};
const member = (relativePath: string, value: unknown): LegacyOperationalMember => ({
  relativePath,
  bytes: encode(value),
});
function sourcePlan() {
  const target = `pull/${ns}/by-id/${hash(pull.external_id)}@2.json`;
  const pointer = `pull/${ns}/by-path/${hash('/deleted/original.md')}.json`;
  return {
    target,
    pointer,
    members: [
      member(target, pull),
      member(pointer, { external_id: pull.external_id, version_number: 2 }),
    ],
  };
}
function seed() {
  const manifest = {
    schema_version: 2,
    options_hash: 'original-selection',
    bundles: [
      {
        filename: 'run%3Aoriginal.md',
        artifact_id: artifactId,
        cluster_key: 'run:original',
        kind: 'run',
        label: 'Original work',
        date: at,
        commit_count: 1,
        checkpoint_count: 1,
        warnings: [],
        nomination_count: 0,
        distinct_task_count: 1,
      },
    ],
  };
  const authored = {
    schema_version: 2,
    cluster_key: 'run:original',
    options_hash: 'original-selection',
    used_pr_context: false,
    label: 'Original work',
    task: 'Preserve the pending decision.',
    steps: [{ label: 'Preserve input', text: 'Retain original bytes.' }],
    checkpoint_summaries: ['Retained'],
    outcome: 'Preserved',
    decisions: [],
  };
  return {
    manifest,
    authored,
    members: [
      member('pending/manifest.json', manifest),
      { relativePath: 'pending/run%3Aoriginal.md', bytes: Buffer.from('Original bundle input\n') },
      member('pending/authored.json', authored),
    ],
  };
}

describe('retained operational reference graphs', () => {
  it('checks normalized server namespaces and approved pointer targets without recovering deleted paths', () => {
    const f = sourcePlan();
    const graph = decodeLegacyOperationalBundle({ kind: 'source-plan', members: f.members });
    expect(graph.references).toEqual([
      { from: f.pointer, to: f.target, relation: 'approved-plan' },
    ]);
    expect(graph.unknownIdentity).toEqual([f.pointer]);
    expect(() => assertDecodedLegacyOperationalBundle(graph)).not.toThrow();
    expect(() => assertDecodedLegacyOperationalBundle({ ...graph })).toThrow(sourceError);
    expect(() =>
      decodeLegacyOperationalBundle({ kind: 'source-plan', members: [f.members[1]!] })
    ).toThrow(missingError);
    f.members[0] = { ...f.members[0]!, relativePath: f.target.replace(ns, '0'.repeat(64)) };
    expect(() =>
      decodeLegacyOperationalBundle({ kind: 'source-plan', members: f.members })
    ).toThrow(sourceError);
  });
  it('keeps candidates, proposals and opaque upload identities separate', () => {
    const candidate = {
      schema_version: 1,
      target: 'candidate',
      external_id: 'plan-1',
      version_id: 'version-3',
      version_number: 3,
      proposal_id: null,
      base_version_number: null,
      body,
      content_hash: hash(body),
      pulled_at: at,
      ...scope,
    };
    const proposal = {
      ...candidate,
      target: 'proposal',
      version_id: null,
      version_number: null,
      proposal_id: 'proposal-1',
      base_version_number: 3,
    };
    const members = [
      member(`review-pull/${ns}/by-id/${hash('plan-1')}.json`, candidate),
      member(`review-pull/${ns}/by-proposal/${hash('proposal-1')}.json`, proposal),
      member(`uploads/${hash('unretained-server-org-path')}.json`, {
        fingerprint: 'retained-fingerprint',
        external_id: 'plan-1',
        unresolved: ['reviewer-1'],
      }),
    ];
    const graph = decodeLegacyOperationalBundle({ kind: 'source-plan', members });
    expect(graph.members).toHaveLength(3);
    expect(graph.unknownIdentity).toEqual([members[2]!.relativePath]);
    members[1] = { ...members[1]!, bytes: encode(candidate) };
    expect(() => decodeLegacyOperationalBundle({ kind: 'source-plan', members })).toThrow(
      sourceError
    );
  });
  it('preserves seed bundle inputs and matching authoring without claiming accepted enrichment', () => {
    const f = seed();
    const graph = decodeLegacyOperationalBundle({ kind: 'seed', members: f.members });
    expect(graph.authoredInputs).toEqual([
      {
        relativePath: 'pending/authored.json',
        selection: 'matching',
        reasons: [],
        acceptance: 'not-established',
      },
    ]);
    expect(graph.references).toHaveLength(2);
    const retained = graph.members.find(
      (entry) => entry.relativePath === 'pending/run%3Aoriginal.md'
    )!;
    f.members[1]!.bytes.fill(0);
    expect(Buffer.from(retained.bytesBase64, 'base64').toString()).toBe('Original bundle input\n');
    expect(Object.isFrozen(graph.authoredInputs[0])).toBe(true);
  });
  it('retains rejected duplicate and unmatched seed authoring as explicit pending input', () => {
    const f = seed();
    f.members.push(
      member('pending/another.json', { ...f.authored, options_hash: 'later-selection', steps: [] })
    );
    f.members.push(
      member('pending/unmatched.json', { ...f.authored, cluster_key: 'run:elsewhere' })
    );
    const graph = decodeLegacyOperationalBundle({ kind: 'seed', members: f.members });
    expect(graph.authoredInputs).toEqual([
      {
        relativePath: 'pending/another.json',
        selection: 'rejected',
        reasons: ['duplicate-cluster', 'options-mismatch', 'checkpoint-count-mismatch'],
        acceptance: 'not-established',
      },
      {
        relativePath: 'pending/authored.json',
        selection: 'rejected',
        reasons: ['duplicate-cluster'],
        acceptance: 'not-established',
      },
      {
        relativePath: 'pending/unmatched.json',
        selection: 'unmatched',
        reasons: [],
        acceptance: 'not-established',
      },
    ]);
    expect(graph.members).toHaveLength(5);
  });
  it('requires manifest-named files and refuses competing manifest identities or unsupported extra bytes', () => {
    const f = seed();
    expect(() =>
      decodeLegacyOperationalBundle({
        kind: 'seed',
        members: f.members.filter((entry) => !entry.relativePath.endsWith('.md')),
      })
    ).toThrow(missingError);
    expect(() =>
      decodeLegacyOperationalBundle({
        kind: 'seed',
        members: f.members.filter((entry) => !entry.relativePath.endsWith('manifest.json')),
      })
    ).toThrow(missingError);
    f.members[0] = {
      ...f.members[0]!,
      bytes: encode({
        ...f.manifest,
        bundles: [...f.manifest.bundles, ...f.manifest.bundles],
      }),
    };
    expect(() => decodeLegacyOperationalBundle({ kind: 'seed', members: f.members })).toThrow(
      sourceError
    );
    expect(() =>
      decodeLegacyOperationalBundle({
        kind: 'seed',
        members: [
          ...seed().members,
          { relativePath: 'pending/unknown.txt', bytes: Buffer.from('Unique unsupported bytes') },
        ],
      })
    ).toThrow(sourceError);
  });
  it('keeps amendment artifact identity and retained enrichment chronology intact', () => {
    const f = seed();
    const amendment = {
      artifact_id: artifactId,
      prior_enrichment_event_id: null,
      member_shas_hash: 'a'.repeat(64),
      decision_mode: 'preserve',
      pr_context_consented: false,
    };
    const members = f.members.map((entry) => ({
      ...entry,
      relativePath: entry.relativePath.replace('pending/', `amend/${artifactId}/`),
    }));
    members[0]!.bytes = encode({ ...f.manifest, amendment });
    members.push(member(`enrichment/${artifactId}.json`, { ...f.authored, enriched_at: at }));
    expect(decodeLegacyOperationalBundle({ kind: 'seed', members }).members).toHaveLength(4);
    members[0]!.bytes = encode({
      ...f.manifest,
      amendment: { ...amendment, artifact_id: '01981808-9400-7000-8000-000000000002' },
    });
    expect(() => decodeLegacyOperationalBundle({ kind: 'seed', members })).toThrow(sourceError);
  });
  it('rejects unsafe or duplicate member paths without exposing payload bytes', () => {
    for (const relativePath of ['/outside', '../outside', 'nested//member', 'nested\\member']) {
      expect(() =>
        decodeLegacyOperationalBundle({
          kind: 'seed',
          members: [{ relativePath, bytes: Buffer.from(body) }],
        })
      ).toThrow(sourceError);
    }
    const f = sourcePlan();
    expect(() =>
      decodeLegacyOperationalBundle({ kind: 'source-plan', members: [...f.members, f.members[0]!] })
    ).toThrow(sourceError);
    try {
      decodeLegacyOperationalBundle({
        kind: 'seed',
        members: [{ relativePath: 'unknown', bytes: Buffer.from(body) }],
      });
    } catch (error) {
      expect(String(error)).not.toContain(body);
    }
  });
});
