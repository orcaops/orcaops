import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  assertDecodedLegacyOperationalFile,
  decodeLegacyOperationalFile,
  type LegacyOperationalKind,
} from './operational.js';
import { LEGACY_SOURCE_REVISION } from './profile.js';

const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const encode = (value: unknown) => Buffer.from(JSON.stringify(value) + '\n');
const at = '2026-07-23T10:00:00.000Z';
const namespace = { base_url: 'https://cloud.example', org_id: 'org_1', pulled_at: at };
const body = '# Plan\n\nfull plan body';
const enrichment = {
  schema_version: 2,
  cluster_key: 'run:abc',
  options_hash: 'original-options',
  used_pr_context: false,
  label: 'Durable cache choice',
  task: 'Adopt a cache that survives process restarts.',
  steps: [{ label: 'Adopt Redis cache', text: 'Add the Redis-backed cache.' }],
  checkpoint_summaries: ['Landed the Redis-backed cache.'],
  outcome: 'Shipped the durable cache.',
  decisions: [
    {
      decision: 'Use Redis for cache storage.',
      reason: 'Retained source reason',
      alternatives_considered: [
        { option: 'memory', rejected_because: 'It loses state during restarts.' },
      ],
    },
  ],
  nomination_dispositions: [{ nomination_id: 'f'.repeat(64), disposition: 'decision' }],
};
const cases: [LegacyOperationalKind, Record<string, unknown>][] = [
  [
    'source_plan_pull',
    {
      schema_version: 1,
      external_id: 'ext-1',
      slug: 'my-plan',
      version_number: 3,
      title: 'My Plan',
      body,
      content_hash: hash(body),
      source_ref: null,
      ...namespace,
    },
  ],
  ['source_plan_path', { external_id: 'ext-1', version_number: 3 }],
  [
    'source_plan_review_pull',
    {
      schema_version: 1,
      target: 'candidate',
      external_id: 'ext-1',
      version_id: 'ver_abc',
      version_number: 4,
      proposal_id: null,
      base_version_number: null,
      content_hash: hash(body),
      body,
      ...namespace,
    },
  ],
  [
    'source_plan_upload',
    {
      fingerprint: 'original-fingerprint',
      external_id: 'original-remote',
      unresolved: ['reviewer'],
    },
  ],
  [
    'seed_journal',
    {
      schema_version: 2,
      install_nonce: 'a'.repeat(32),
      options_hash: 'original-options',
      updated_at: at,
      clusters: { 'run:abc': { artifact_id: 'artifact-1', status: 'writing' } },
      jobs: {
        'job-1': {
          kind: 'initial',
          invoked_by: 'codex',
          started_at: at,
          budget: { max_commits: 20, selected_commits: 5 },
        },
      },
    },
  ],
  [
    'seed_journal',
    {
      schema_version: 1,
      install_nonce: 'a'.repeat(32),
      options_hash: 'original-options',
      pr_context: true,
      pending_importance: true,
      updated_at: at,
      clusters: { 'run:abc': { artifact_id: 'artifact-1', status: 'writing' } },
      declined_discovery_areas: ['src/private'],
      commit_graph_hint_shown: true,
    },
  ],
  [
    'seed_state',
    {
      schema_version: 1,
      install_nonce: 'a'.repeat(32),
      pr_context: true,
      pending_importance: true,
      commit_graph_hint_shown: true,
      discovery_areas: { src: { declined_at: at, declined_paths: ['src/private'] } },
      updated_at: at,
    },
  ],
  [
    'seed_coverage',
    {
      schema_version: 1,
      branch_sha: 'a'.repeat(40),
      generated_at: at,
      complete: false,
      directories: { src: { covered_lines: 1, total_lines: 4, percent: 25 } },
    },
  ],
  ['seed_enrichment', enrichment],
  ['seed_enrichment_retained', { ...enrichment, enriched_at: at }],
  [
    'seed_bundle',
    {
      schema_version: 2,
      options_hash: 'original-options',
      amendment: {
        artifact_id: 'artifact-1',
        prior_enrichment_event_id: null,
        member_shas_hash: 'a'.repeat(64),
        decision_mode: 'preserve',
        pr_context_consented: true,
      },
      bundles: [
        {
          filename: 'cluster.md',
          artifact_id: 'artifact-1',
          cluster_key: 'run:abc',
          kind: 'run',
          label: 'Durable cache choice',
          date: at,
          commit_count: 1,
          checkpoint_count: 1,
          warnings: [],
          nomination_count: 1,
          distinct_task_count: 1,
        },
      ],
    },
  ],
];
const sourceError = expect.objectContaining({ code: 'SOURCE_INTEGRITY' });

describe('frozen operational source provenance', () => {
  it('pins schema dependencies and the complete SQLite baseline without old readers or migrations', () => {
    const manifest = JSON.parse(
      readFileSync(new URL('../legacy-operational-sources.json', import.meta.url), 'utf8')
    ) as {
      source_revision: string;
      sources: {
        source_path: string;
        source_sha256: string;
        output_path: string;
        output_sha256: string;
        selected_symbols: string[];
      }[];
    };
    expect(manifest.source_revision).toBe(LEGACY_SOURCE_REVISION);
    expect(manifest.sources).toHaveLength(9);
    expect(
      manifest.sources.some((source) => source.output_path.includes('/review-feedback/'))
    ).toBe(false);
    expect(
      manifest.sources.some((source) =>
        source.output_path.endsWith('/source-plan/review-pull-cache.ts')
      )
    ).toBe(true);
    for (const source of manifest.sources) {
      expect(
        hash(execFileSync('git', ['show', `${LEGACY_SOURCE_REVISION}:${source.source_path}`]))
      ).toBe(source.source_sha256);
      const output = readFileSync(new URL('../' + source.output_path, import.meta.url));
      expect(hash(output)).toBe(source.output_sha256);
      expect(output.toString('utf8')).not.toMatch(
        /['"](?:node:(?:fs|child_process|net|http)|@orcaops\/(?:storage|core|project-scope))(?:\/[^'"]*)?['"]/
      );
      if (source.source_path.endsWith('/seed/journal.ts'))
        expect(source.selected_symbols).toContain('SeedJournalV1Schema');
    }
  });
});

describe('retained operational records', () => {
  it.each(cases)(
    'preserves %s exact fields and refuses incomplete or unrecognized structure',
    (kind, raw) => {
      const bytes = encode(raw);
      const file = decodeLegacyOperationalFile(kind, bytes);
      expect(file.value).toEqual(raw);
      expect(Buffer.from(file.bytesBase64, 'base64')).toEqual(bytes);
      expect(() => assertDecodedLegacyOperationalFile(file)).not.toThrow();
      expect(() => decodeLegacyOperationalFile(kind, encode({}))).toThrow(sourceError);
      expect(() =>
        decodeLegacyOperationalFile(
          kind,
          encode({ ...raw, unsupported_unique_state: 'preserve me' })
        )
      ).toThrow(sourceError);
      if (raw.schema_version !== undefined)
        expect(() =>
          decodeLegacyOperationalFile(kind, encode({ ...raw, schema_version: 999 }))
        ).toThrow(sourceError);
    }
  );

  it('keeps candidate and proposal CAS identities disjoint from approved source plans', () => {
    const candidate = cases.find(([kind]) => kind === 'source_plan_review_pull')![1];
    const proposal = {
      ...candidate,
      target: 'proposal',
      version_id: null,
      version_number: null,
      proposal_id: 'prop_xyz',
      base_version_number: 4,
    };
    expect(decodeLegacyOperationalFile('source_plan_review_pull', encode(proposal)).value).toEqual(
      proposal
    );
    for (const raw of [
      { ...candidate, proposal_id: 'prop_xyz' },
      { ...proposal, version_id: 'ver_abc' },
      { ...proposal, version_number: 4 },
    ])
      expect(() => decodeLegacyOperationalFile('source_plan_review_pull', encode(raw))).toThrow(
        sourceError
      );
    expect(() => decodeLegacyOperationalFile('source_plan_pull', encode(candidate))).toThrow(
      sourceError
    );
  });

  it('checks retained body hashes and keeps source payloads out of errors', () => {
    for (const [kind, raw] of cases.filter(([kind]) =>
      ['source_plan_pull', 'source_plan_review_pull'].includes(kind)
    )) {
      try {
        decodeLegacyOperationalFile(kind, encode({ ...raw, content_hash: '0'.repeat(64) }));
        throw new Error('expected refusal');
      } catch (error) {
        expect(error).toMatchObject({ code: 'SOURCE_INTEGRITY' });
        expect(String(error)).not.toContain(body);
      }
    }
  });

  it('does not erase interrupted seed work or turn incomplete coverage into absence proof', () => {
    const state = cases.find(([kind]) => kind === 'seed_state')!;
    expect(
      decodeLegacyOperationalFile(...([state[0], encode(state[1])] as const)).value
    ).toMatchObject({ install_nonce: 'a'.repeat(32), pending_importance: true });
    const journal = cases.find(([kind]) => kind === 'seed_journal')![1];
    expect(decodeLegacyOperationalFile('seed_journal', encode(journal)).value).toMatchObject({
      clusters: { 'run:abc': { status: 'writing' } },
    });
    expect(() =>
      decodeLegacyOperationalFile('seed_journal', encode({ ...journal, schema_version: 1 }))
    ).toThrow(sourceError);
    const coverage = cases.find(([kind]) => kind === 'seed_coverage')![1];
    expect(decodeLegacyOperationalFile('seed_coverage', encode(coverage)).value).toMatchObject({
      complete: false,
    });
    expect(() =>
      decodeLegacyOperationalFile(
        'seed_enrichment',
        encode({
          ...enrichment,
          nomination_dispositions: [{ nomination_id: 'f'.repeat(64), disposition: 'skipped' }],
        })
      )
    ).toThrow(sourceError);
  });

  it('refuses forged provenance and malformed retained bytes', () => {
    const original = decodeLegacyOperationalFile(
      'source_plan_path',
      encode({ external_id: 'ext-1', version_number: 3 })
    );
    expect(() => assertDecodedLegacyOperationalFile({ ...original })).toThrow(sourceError);
    expect(() => decodeLegacyOperationalFile('source_plan_path', Buffer.from([0xff]))).toThrow(
      sourceError
    );
  });
});
