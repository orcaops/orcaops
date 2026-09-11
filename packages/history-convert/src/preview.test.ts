import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { decodeLegacyArtifact } from './artifact.js';
import { redactSecretsInValue } from './legacy/protocol/secrets.js';
import { canonicalJson } from './legacy/storage/events/canonical-json.js';
import {
  assertPreparedLegacySources,
  prepareLegacySources,
  readPreparedLegacyArtifact,
  readPreparedLegacyDecisions,
  readPreparedLegacyRemote,
  readPreparedLegacySeedState,
  readPreparedLegacySource,
  readPreparedLegacyUsage,
} from './prepared-sources.js';
import { assertLegacyPreview, previewLegacyRepository } from './preview.js';
import * as observations from './source-files.js';

const exec = promisify(execFile);
const roots: string[] = [];
const artifactId = '01999999-9999-7000-8000-000000000001';
const secondId = '01999999-9999-7000-8000-000000000002';
const plan = JSON.parse(
  readFileSync(new URL('../fixtures/artifact-plan.json', import.meta.url), 'utf8')
);
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const encode = (value: unknown) => Buffer.from(JSON.stringify(value) + '\n');
const seedJournal = () => ({
  schema_version: 1,
  install_nonce: 'a'.repeat(32),
  options_hash: 'original-options',
  pr_context: true,
  pending_importance: true,
  updated_at: '2026-07-23T10:00:00.000Z',
  clusters: { work: { artifact_id: artifactId, status: 'writing' } },
  declined_discovery_areas: ['src/private'],
});
function record(payload: unknown, type = 'plan_captured') {
  const unsigned = {
    event_id: artifactId,
    type,
    ts: '2026-04-26T12:00:00.000Z',
    schema_version: 1,
    idempotency_key: 'source-record',
    payload,
  };
  return encode({ ...unsigned, checksum: hash(canonicalJson(unsigned)) });
}
async function fixture() {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'orcaops-preview-')));
  roots.push(directory);
  const cwd = path.join(directory, 'repo');
  await fs.mkdir(cwd);
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
  for (const key of [
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_COMMON_DIR',
    'GIT_INDEX_FILE',
    'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  ])
    delete env[key as keyof typeof env];
  await exec('git', ['-C', cwd, 'init', '-qb', 'main'], { env });
  await exec(
    'git',
    [
      '-C',
      cwd,
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.test',
      'commit',
      '--allow-empty',
      '-qm',
      'Initial',
    ],
    { env }
  );
  const write = async (name: string, bytes: Buffer) => {
    const file = path.join(cwd, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, bytes);
    return file;
  };
  return { directory, options: { cwd, root: path.join(directory, 'data'), env }, write };
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('retained repository preview', { timeout: 30_000 }, () => {
  it('reports artifact identity and exact event counts without exposing retained narrative', async () => {
    const f = await fixture();
    await f.write(`.orcaops/artifacts/${artifactId}/events.ndjson`, record(plan));
    const before = await observations.inventoryLegacySource({ root: f.directory });
    const result = await previewLegacyRepository(f.options);
    expect(result).toMatchObject({
      contentComplete: true,
      verifiedEmpty: false,
      resources: [{ kind: 'artifact', id: artifactId, state: 'verified', records: 1, files: 1 }],
    });
    expect(JSON.stringify(result)).not.toContain('do the thing');
    expect(Object.isFrozen(result.resources[0])).toBe(true);
    expect(await observations.inventoryLegacySource({ root: f.directory })).toEqual(before);
  });
  it('prepares every original member without allocating authority or changing its reviewed source tree', async () => {
    const f = await fixture();
    const original = record(plan);
    const file = await f.write(`.orcaops/artifacts/${artifactId}/events.ndjson`, original);
    const configuration = Buffer.from('  {"schema_version":6}\n');
    const config = await f.write('.orcaops/config.json', configuration);
    const preview = await previewLegacyRepository(f.options);
    const before = await observations.inventoryLegacySource({ root: f.directory });
    const prepared = await prepareLegacySources(preview);
    expect(prepared.manifest.files.map((member) => member.location)).toEqual([file, config].sort());
    expect(prepared.manifest.project_id).toBeNull();
    expect(prepared.manifest.preview_manifest_sha256).toBe(preview.manifestHash);
    const decisions = readPreparedLegacyDecisions(prepared);
    const { target, ...reviewed } = preview;
    // Target presence is observed by name, never reviewed as a source, so the decisions record
    // and the prepared hash stay stable once a conversion creates its own target.
    expect(JSON.parse(decisions.toString())).toEqual(reviewed);
    expect(JSON.parse(decisions.toString())).not.toHaveProperty('target');
    expect(target).toBeDefined();
    expect(prepared.manifest.decisions).toEqual({
      sha256: createHash('sha256').update(decisions).digest('hex'),
      byte_length: decisions.length,
    });
    expect(prepared.manifestSha256).toBe(hash(canonicalJson(prepared.manifest)));
    expect(readPreparedLegacySource(prepared, file)).toEqual(original);
    expect(readPreparedLegacySource(prepared, config)).toEqual(configuration);
    const copy = readPreparedLegacySource(prepared, file);
    copy.fill(0);
    expect(readPreparedLegacySource(prepared, file)).toEqual(original);
    expect(Object.isFrozen(prepared.manifest.files[0]!.identity)).toBe(true);
    expect(() => assertPreparedLegacySources({ ...prepared })).toThrow();
    expect(() => readPreparedLegacySource(prepared, 'unrecorded')).toThrow();
    expect(JSON.stringify(prepared)).not.toContain('do the thing');
    expect(await observations.inventoryLegacySource({ root: f.directory })).toEqual(before);
  });
  it('refuses incomplete previews, forged reports and changed original bytes before preparation', async () => {
    const f = await fixture();
    const file = await f.write(`.orcaops/artifacts/${artifactId}/events.ndjson`, record(plan));
    const preview = await previewLegacyRepository(f.options);
    await expect(prepareLegacySources({ ...preview })).rejects.toMatchObject({
      code: 'SOURCE_INTEGRITY',
    });
    await fs.writeFile(file, record({ ...plan, task: 'changed after preview' }));
    await expect(prepareLegacySources(preview)).rejects.toMatchObject({ code: 'SOURCE_CHANGED' });
    await f.write('.orcaops/unknown.json', encode({ unknown: 'original' }));
    const incomplete = await previewLegacyRepository(f.options);
    await expect(prepareLegacySources(incomplete)).rejects.toMatchObject({
      code: 'SOURCE_UNAVAILABLE',
    });
  });
  it('detects added source membership during preparation instead of certifying its earlier file list', async () => {
    const f = await fixture();
    await f.write(`.orcaops/artifacts/${artifactId}/events.ndjson`, record(plan));
    const preview = await previewLegacyRepository(f.options);
    const original = observations.observeLegacySourceFile;
    let changed = false;
    vi.spyOn(observations, 'observeLegacySourceFile').mockImplementation(async (input) => {
      const result = await original(input);
      if (input.includeBytes && !changed) {
        changed = true;
        await f.write('.orcaops/new-original.json', encode({ unique: true }));
      }
      return result;
    });
    await expect(prepareLegacySources(preview)).rejects.toMatchObject({ code: 'SOURCE_CHANGED' });
  });
  it('keeps empty expected artifacts and corrupt siblings unavailable while reporting healthy retained input', async () => {
    const f = await fixture();
    await f.write(`.orcaops/artifacts/${artifactId}/events.ndjson`, record(plan));
    await fs.mkdir(path.join(f.options.cwd, '.orcaops/artifacts', secondId));
    const report = await previewLegacyRepository(f.options);
    expect(report.contentComplete).toBe(false);
    expect(report.resources).toContainEqual(
      expect.objectContaining({ id: secondId, state: 'unavailable', records: null })
    );
    expect(report.resources).toContainEqual(
      expect.objectContaining({ id: artifactId, state: 'verified', records: 1 })
    );
    expect(report.issues).toContainEqual(expect.objectContaining({ code: 'SOURCE_UNAVAILABLE' }));
  });
  it('does not discard unverified auxiliaries or classify unknown precious files as empty', async () => {
    const f = await fixture();
    await f.write(`.orcaops/artifacts/${artifactId}/events.ndjson`, record(plan));
    await f.write(
      `.orcaops/artifacts/${artifactId}/derived/unknown.json`,
      encode({ unique: 'preserve private content' })
    );
    await f.write('.orcaops/unique-state.json', encode({ secret: 'not reportable' }));
    const report = await previewLegacyRepository(f.options);
    expect(report.contentComplete).toBe(false);
    expect(report.verifiedEmpty).toBe(false);
    expect(report.issues).toContainEqual(
      expect.objectContaining({ code: 'UNSUPPORTED_RESOURCE_SCHEMA' })
    );
    expect(report.unclassified).toEqual([
      expect.objectContaining({ location: path.join(f.options.cwd, '.orcaops/unique-state.json') }),
    ]);
    expect(JSON.stringify(report)).not.toMatch(/preserve private content|not reportable/);
  });

  it('retains artifact backups and filesystem metadata without interpreting their bytes', async () => {
    const f = await fixture();
    await f.write(`.orcaops/artifacts/${artifactId}/events.ndjson`, record(plan));
    const backup = await f.write('.orcaops/artifacts.zip', Buffer.from('opaque backup'));
    const metadata = await f.write('.orcaops/.DS_Store', Buffer.from('opaque metadata'));
    const nested = await f.write(
      `.orcaops/artifacts/${artifactId}/.DS_Store`,
      Buffer.from('nested metadata')
    );
    const report = await previewLegacyRepository(f.options);
    expect(report.contentComplete).toBe(true);
    expect(report.unclassified).toEqual([]);
    expect(report.retained).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ location: backup, family: 'artifact-backup' }),
        expect.objectContaining({ location: metadata, family: 'filesystem-metadata' }),
      ])
    );
    const prepared = await prepareLegacySources(report);
    expect(readPreparedLegacySource(prepared, backup)).toEqual(Buffer.from('opaque backup'));
    expect(readPreparedLegacySource(prepared, metadata)).toEqual(Buffer.from('opaque metadata'));
    expect(readPreparedLegacySource(prepared, nested)).toEqual(Buffer.from('nested metadata'));
    expect(report.retained).toContainEqual(
      expect.objectContaining({ location: nested, family: 'filesystem-metadata' })
    );
  });

  it('reports generated attachment fidelity without including its different narrative or replacing events', async () => {
    const f = await fixture();
    const bytes = record(plan);
    await f.write(`.orcaops/artifacts/${artifactId}/events.ndjson`, bytes);
    const decoded = decodeLegacyArtifact({ artifactId, bytes });
    await f.write(
      `.orcaops/artifacts/${artifactId}/plan.json`,
      encode({ ...decoded.plan, task: 'Unique old generated narrative' })
    );
    await f.write(
      `.orcaops/artifacts/${artifactId}/plan.md`,
      Buffer.from('Retained old rendering\n')
    );
    const report = await previewLegacyRepository(f.options);
    expect(report.contentComplete).toBe(true);
    expect(report.resources[0]!.fidelity).toEqual([
      expect.objectContaining({
        relativePath: 'plan.json',
        authority: 'original-attachment',
        fidelity: 'differs-from-current',
      }),
      expect.objectContaining({
        relativePath: 'plan.md',
        authority: 'original-attachment',
        fidelity: 'differs-from-current',
      }),
    ]);
    expect(JSON.stringify(report)).not.toMatch(
      /Unique old generated narrative|Retained old rendering/
    );
    expect(report.activationEligible).toBe(false);
  });
  it('uses the captured effective source layout', async () => {
    const f = await fixture();
    await f.write(
      '.orcaops/config.json',
      encode({
        schema_version: 6,
        artifacts: { path: 'history' },
        cache: { path: '.local/cache.sqlite' },
      })
    );
    await f.write(`history/${artifactId}/events.ndjson`, record(plan));
    const result = await previewLegacyRepository(f.options);
    expect(result).toMatchObject({ contentComplete: true, verifiedEmpty: false, unclassified: [] });
    expect(result.resources).toContainEqual(
      expect.objectContaining({
        kind: 'artifact',
        source: path.join(f.options.cwd, 'history', artifactId),
        state: 'verified',
      })
    );
  });
  it('rejects invalid usage payloads even when their retained envelope checksum matches', async () => {
    const f = await fixture();
    await f.write(
      '.orcaops/usage/ledger.ndjson',
      record({ cumulative_usage: -1 }, 'agent_usage_snapshot_recorded')
    );
    const report = await previewLegacyRepository(f.options);
    expect(report).toMatchObject({
      contentComplete: false,
      resources: [{ kind: 'usage', state: 'unavailable' }],
    });
  });
  it('reports divergent artifact copies and requires a complete reviewed choice for retained redaction', async () => {
    const f = await fixture();
    await exec('git', ['-C', f.options.cwd, 'config', '--local', 'orcaops.projectid', artifactId], {
      env: f.options.env,
    });
    const raw = { ...plan, task: 'Keep api_key=testing1234 in original evidence' };
    const hot = await f.write(`.orcaops/artifacts/${artifactId}/events.ndjson`, record(raw));
    const archived = await f.write(
      `../data/projects/${artifactId}/artifacts/${artifactId}/events.ndjson`,
      record(redactSecretsInValue(raw))
    );
    const first = await previewLegacyRepository(f.options);
    expect(first.contentComplete).toBe(false);
    expect(first.issues).toContainEqual(
      expect.objectContaining({
        code: 'SOURCE_CONFLICT',
        reason: expect.stringContaining('hash-bound reviewed'),
      })
    );
    const sources = first.resources
      .filter((resource) => resource.kind === 'artifact')
      .map((resource) => ({ sourceId: resource.source, sha256: resource.sourceHash! }));
    const artifactRepresentations = [
      { artifactId, choice: { sourceId: path.dirname(archived), sources } },
    ];
    const pending = previewLegacyRepository({ ...f.options, artifactRepresentations });
    sources[0]!.sha256 = '0'.repeat(64);
    const selected = await pending;
    expect(selected.contentComplete).toBe(true);
    expect(selected.representations[0]!.selection).toMatchObject({
      sourceId: path.dirname(archived),
      reviewed: true,
    });
    expect(selected.representations[0]!.selection.sources).toContainEqual(
      expect.objectContaining({ sourceId: path.dirname(hot), fidelity: 'selected-redacted' })
    );
    expect(JSON.stringify(selected)).not.toContain('testing1234');
    await fs.writeFile(archived, record({ ...raw, task: 'Conflicting authoritative prose' }));
    const divergent = await previewLegacyRepository(f.options);
    expect(divergent.contentComplete).toBe(false);
    expect(divergent.issues).toContainEqual(expect.objectContaining({ code: 'SOURCE_CONFLICT' }));
  });
  it('detects mutation between discovery and decoding instead of returning an earlier complete report', async () => {
    const f = await fixture();
    const file = await f.write(`.orcaops/artifacts/${artifactId}/events.ndjson`, record(plan));
    const observe = observations.observeLegacySourceFile;
    vi.spyOn(observations, 'observeLegacySourceFile').mockImplementation(async (input) => {
      if (input.includeBytes && input.relativePath.endsWith('events.ndjson'))
        await fs.writeFile(file, record({ ...plan, task: 'changed' }));
      return observe(input);
    });
    await expect(previewLegacyRepository(f.options)).rejects.toMatchObject({
      code: 'SOURCE_CHANGED',
    });
  });
  it('retains every original remote occurrence without adopting an account or choosing authored variants', async () => {
    const f = await fixture();
    const ns = hash('https://cloud.example|org');
    const remote = {
      base_url: 'https://CLOUD.example/',
      org_id: 'org',
      pulled_at: 'original recorded time',
    };
    const approved = {
      schema_version: 1,
      external_id: 'plan',
      slug: 'plan',
      version_number: 1,
      title: 'Plan',
      body: 'Original body',
      content_hash: hash('Original body'),
      source_ref: null,
      ...remote,
    };
    const sourcePlan = '.orcaops/cache/source-plan';
    const approvedPath = `${sourcePlan}/pull/${ns}/by-id/${hash('plan')}@1.json`;
    await f.write(approvedPath, encode(approved));
    for (const originalPath of ['/authored/a.md', '/authored/b.md'])
      await f.write(
        `${sourcePlan}/pull/${ns}/by-path/${hash(originalPath)}.json`,
        encode({ external_id: 'plan', version_number: 1 })
      );
    await f.write(
      `${sourcePlan}/review-pull/${ns}/by-id/${hash('plan')}.json`,
      encode({
        schema_version: 1,
        target: 'candidate',
        external_id: 'plan',
        version_id: 'candidate',
        version_number: 2,
        proposal_id: null,
        base_version_number: 1,
        body: 'Candidate',
        content_hash: hash('Candidate'),
        ...remote,
      })
    );
    await f.write(
      `${sourcePlan}/review-pull/${ns}/by-proposal/${hash('proposal')}.json`,
      encode({
        schema_version: 1,
        target: 'proposal',
        external_id: 'plan',
        version_id: null,
        version_number: null,
        proposal_id: 'proposal',
        base_version_number: 1,
        body: 'Proposal',
        content_hash: hash('Proposal'),
        ...remote,
      })
    );
    const locator = hash('unrecoverable original target and path');
    await f.write(
      `${sourcePlan}/uploads/${locator}.json`,
      encode({ fingerprint: 'original-fingerprint', external_id: 'plan', unresolved: ['reviewer'] })
    );
    const sibling = path.join(f.directory, 'sibling');
    await exec('git', ['-C', f.options.cwd, 'worktree', 'add', '-qb', 'sibling', sibling], {
      env: f.options.env,
    });
    await fs.cp(path.join(f.options.cwd, '.orcaops'), path.join(sibling, '.orcaops'), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(sibling, approvedPath),
      encode({
        ...approved,
        body: 'Distinct authored body',
        content_hash: hash('Distinct authored body'),
      })
    );
    const preview = await previewLegacyRepository(f.options);
    expect(preview.contentComplete).toBe(true);
    const sources = await prepareLegacySources(preview);

    const graphs = readPreparedLegacyRemote(sources);
    expect(graphs).toHaveLength(2);
    const members = graphs.flatMap(({ source, graph }) =>
      graph.members.map((member) => ({ source, member }))
    );
    expect(members).toHaveLength(12);
    for (const { source, member } of members) {
      expect(Buffer.from(member.file!.bytesBase64, 'base64')).toEqual(
        readPreparedLegacySource(sources, path.join(source, member.relativePath))
      );
    }
    expect(
      members
        .filter(({ member }) => member.file!.kind === 'source_plan_pull')
        .map(({ member }) => (member.file!.value as { body: string }).body)
        .sort()
    ).toEqual(['Distinct authored body', 'Original body']);
    expect(() => readPreparedLegacyRemote({ ...sources })).toThrow();
  });
  it('prepares original seed journals with all identical source locations and no invented decline dates', async () => {
    const f = await fixture();
    const original = Buffer.from(JSON.stringify(seedJournal(), null, 2) + '\n');
    const firstPath = await f.write('.orcaops/cache/seed/journal.json', original);
    const coverage = encode({
      schema_version: 1,
      branch_sha: 'a'.repeat(40),
      generated_at: seedJournal().updated_at,
      complete: false,
      directories: { src: { covered_lines: 1, total_lines: 4, percent: 25 } },
    });
    await f.write('.orcaops/cache/seed/coverage.json', coverage);
    const sibling = path.join(f.directory, 'sibling');
    await exec('git', ['-C', f.options.cwd, 'worktree', 'add', '-qb', 'sibling', sibling], {
      env: f.options.env,
    });
    const secondPath = path.join(sibling, '.orcaops/cache/seed/journal.json');
    await fs.mkdir(path.dirname(secondPath), { recursive: true });
    await fs.writeFile(secondPath, original);
    const sources = await prepareLegacySources(await previewLegacyRepository(f.options));

    const occurrences = readPreparedLegacySeedState(sources);
    expect(
      occurrences
        .filter((entry) => entry.key === 'journal')
        .map((entry) => entry.originalPath)
        .sort()
    ).toEqual([firstPath, secondPath].sort());
    for (const entry of occurrences)
      expect(Buffer.from(entry.file.bytesBase64, 'base64')).toEqual(
        readPreparedLegacySource(sources, entry.originalPath)
      );
    expect(occurrences.find((entry) => entry.key === 'coverage')?.file.bytesBase64).toBe(
      coverage.toString('base64')
    );
    expect(readPreparedLegacySource(sources, firstPath)).toEqual(original);
    expect(original.toString()).not.toContain('declined_at');
    expect(() => readPreparedLegacySeedState({ ...sources })).toThrow();
  });
  it('retains a verified empty usage source without inventing a usage publication', async () => {
    const f = await fixture();
    const original = await f.write('.orcaops/usage/ledger.ndjson', Buffer.alloc(0));
    const preview = await previewLegacyRepository(f.options);
    const sources = await prepareLegacySources(preview);

    expect(readPreparedLegacyUsage(sources)?.records).toEqual([]);
    expect(readPreparedLegacyUsage(sources)?.eventBytesBase64).toBe('');
    expect(
      sources.manifest.files.some((file) => file.location === original && file.size === 0)
    ).toBe(true);
    expect(readPreparedLegacySource(sources, original)).toEqual(Buffer.alloc(0));
  });
  it('establishes empty inventory without allocating authority, opening a disk cache or changing source bytes', async () => {
    const f = await fixture();
    const before = await observations.inventoryLegacySource({ root: f.directory });
    const preview = await previewLegacyRepository(f.options);
    expect(preview).toMatchObject({
      producerEvidence: 'unknown',
      projectId: null,
      inventoryComplete: true,
      contentComplete: true,
      verifiedEmpty: true,
      activationEligible: false,
      resources: [],
      issues: [],
      unclassified: [],
    });
    expect(() => assertLegacyPreview(preview)).not.toThrow();
    expect(() => assertLegacyPreview({ ...preview })).toThrow();
    expect(await observations.inventoryLegacySource({ root: f.directory })).toEqual(before);
    const sources = await prepareLegacySources(preview);

    expect(readPreparedLegacyUsage(sources)).toBeNull();
    expect(readPreparedLegacySeedState(sources)).toEqual([]);
    expect(readPreparedLegacyRemote(sources)).toEqual([]);
    expect(await observations.inventoryLegacySource({ root: f.directory })).toEqual(before);
  });
  it('prepares the selected original artifact bytes and attachments without creating execution history', async () => {
    const f = await fixture();
    const original = record(plan);
    const retained = Buffer.from('Original retained rendering\n');
    await f.write(`.orcaops/artifacts/${artifactId}/events.ndjson`, original);
    await f.write(`.orcaops/artifacts/${artifactId}/plan.md`, retained);
    const preview = await previewLegacyRepository(f.options);
    const sources = await prepareLegacySources(preview);
    const before = await observations.inventoryLegacySource({ root: f.directory });

    const selected = readPreparedLegacyArtifact(sources, artifactId);
    expect(selected.selection.manifestHash).toBe(
      preview.representations[0]!.selection.manifestHash
    );
    expect(
      readPreparedLegacySource(
        sources,
        path.join(f.options.cwd, '.orcaops/artifacts', artifactId, 'events.ndjson')
      )
    ).toEqual(original);
    expect(
      Buffer.from(
        selected.bundle.members.find((member) => member.relativePath === 'plan.md')!.bytesBase64,
        'base64'
      )
    ).toEqual(retained);
    expect(() => readPreparedLegacyArtifact({ ...sources }, artifactId)).toThrow();
    expect(() => readPreparedLegacyArtifact(sources, secondId)).toThrow('reviewed representation');
    expect(await observations.inventoryLegacySource({ root: f.directory })).toEqual(before);
  });
  it('separates original usage occurrence preservation from selected facts across worktrees and repair copies', async () => {
    const f = await fixture();
    await exec('git', ['-C', f.options.cwd, 'config', '--local', 'orcaops.projectid', artifactId], {
      env: f.options.env,
    });
    await exec(
      'git',
      ['-C', f.options.cwd, 'worktree', 'add', '-qb', 'sibling', path.join(f.directory, 'sibling')],
      { env: f.options.env }
    );
    const usage = (eventId: string, key: string, target: string) => {
      const unsigned = {
        event_id: eventId,
        type: 'source_plan_linked',
        ts: '2026-04-26T12:00:00.000Z',
        schema_version: 1,
        idempotency_key: key,
        payload: {
          canonical_ref_id: 'Unique private original source plan',
          artifact_id: target,
          linked_at: '2026-04-26T12:00:00.000Z',
          pinned_version: null,
        },
      };
      return encode({ ...unsigned, checksum: hash(canonicalJson(unsigned)) });
    };
    const first = usage(artifactId, 'one', artifactId);
    const second = usage(secondId, 'two', secondId);
    const repaired = usage(artifactId, 'one', secondId);
    await f.write('.orcaops/usage/ledger.ndjson', first);
    const sibling = await f.write('../sibling/.orcaops/usage/ledger.ndjson', second);
    await f.write(
      `../data/projects/${artifactId}/usage/ledger.ndjson`,
      Buffer.concat([first, second, repaired])
    );
    const preview = await previewLegacyRepository(f.options);
    expect(preview.contentComplete).toBe(true);
    expect(preview.resources.filter((resource) => resource.kind === 'usage')).toHaveLength(3);
    expect(preview.usageSelection?.counts).toEqual({
      originalOccurrences: 5,
      selectedSnapshots: 0,
      selectedLinks: 2,
      retainedEvidenceOccurrences: 3,
    });
    expect(preview.usageSelection?.occurrences).toHaveLength(5);
    expect(JSON.stringify(preview)).not.toContain('Unique private original source plan');
    const sources = await prepareLegacySources(preview);

    const selected = readPreparedLegacyUsage(sources)!;
    expect(selected.counts).toEqual(preview.usageSelection!.counts);
    expect(selected.occurrences).toHaveLength(5);
    expect(selected.records).toHaveLength(2);
    expect(readPreparedLegacySource(sources, sibling)).toEqual(second);
    expect(() => readPreparedLegacyUsage({ ...sources })).toThrow();
  });
  it('refuses canonical registration presence without reading its payload as source authority', async () => {
    const f = await fixture();
    const marker = await f.write(
      '.git/orcaops/registration.json',
      Buffer.from('not canonical JSON')
    );
    const before = await observations.inventoryLegacySource({ root: f.directory });
    const preview = await previewLegacyRepository(f.options);
    expect(preview.inventoryComplete).toBe(false);
    expect(preview.contentComplete).toBe(false);
    expect(preview.activationEligible).toBe(false);
    expect(preview.projectId).toBeNull();
    expect(preview.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'SOURCE_CONFLICT' })])
    );
    expect(JSON.stringify(preview)).not.toContain('not canonical JSON');
    await expect(prepareLegacySources(preview)).rejects.toMatchObject({
      code: 'SOURCE_UNAVAILABLE',
    });
    expect(await fs.readFile(marker, 'utf8')).toBe('not canonical JSON');
    expect(await observations.inventoryLegacySource({ root: f.directory })).toEqual(before);
  });
  it('discloses excluded checkout and archive reviews without reading malformed or missing evidence', async () => {
    const f = await fixture();
    await exec('git', ['-C', f.options.cwd, 'config', '--local', 'orcaops.projectid', artifactId], {
      env: f.options.env,
    });
    await f.write(`.orcaops/artifacts/${artifactId}/events.ndjson`, record(plan));
    await f.write('.orcaops/reviews/run/broken.json', Buffer.from('malformed checkout review'));
    await f.write('.orcaops/cache/review-feedback/invalid.json', Buffer.from('malformed feedback'));
    await f.write(
      `../data/projects/${artifactId}/reviews/v4/run/broken.json`,
      Buffer.from('divergent malformed archive review')
    );
    await fs.symlink(
      '/missing-evidence',
      path.join(f.options.cwd, '.orcaops/reviews/missing-floor')
    );
    const observe = vi.spyOn(observations, 'observeLegacySourceFile');
    const preview = await previewLegacyRepository(f.options);
    expect(preview.contentComplete).toBe(true);
    expect(preview.omitted.map((entry) => entry.family)).toEqual([
      'task-review-refs',
      'task-review',
      'task-review-feedback',
      'task-review',
    ]);
    expect(preview.omitted.every((entry) => entry.state === 'intentionally-not-inspected')).toBe(
      true
    );
    const prepared = await prepareLegacySources(preview);
    expect(prepared.manifest.omitted).toEqual(preview.omitted);
    expect(prepared.manifest.files).toHaveLength(1);
    expect(
      observe.mock.calls.some(([input]) => /(?:reviews|review-feedback)/.test(input.relativePath))
    ).toBe(false);
    expect(() =>
      readPreparedLegacySource(
        prepared,
        path.join(f.options.cwd, '.orcaops/reviews/run/broken.json')
      )
    ).toThrow(/not covered/);
  });

  it('keeps the same prepared source when excluded roots and refs appear or disappear', async () => {
    const f = await fixture();
    await f.write(`.orcaops/artifacts/${artifactId}/events.ndjson`, record(plan));
    await fs.mkdir(path.join(f.options.cwd, '.orcaops/cache'));
    const preview = await previewLegacyRepository(f.options);
    await f.write('.orcaops/reviews/broken', Buffer.from('excluded'));
    await f.write('.orcaops/cache/review-feedback/broken', Buffer.from('excluded'));
    await exec('git', ['-C', f.options.cwd, 'update-ref', 'refs/orcaops/review/original', 'HEAD'], {
      env: f.options.env,
    });
    await f.write('.git/refs/orcaops/review/missing-object', Buffer.from('f'.repeat(40) + '\n'));
    await exec(
      'git',
      [
        '-C',
        f.options.cwd,
        'symbolic-ref',
        'refs/orcaops/review/missing-target',
        'refs/heads/not-present',
      ],
      { env: f.options.env }
    );
    const first = await prepareLegacySources(preview);
    await f.write('.orcaops/reviews/broken', Buffer.from('changed excluded bytes'));
    expect((await prepareLegacySources(preview)).manifestSha256).toBe(first.manifestSha256);
    await fs.rm(path.join(f.options.cwd, '.orcaops/reviews'), { recursive: true });
    await fs.rm(path.join(f.options.cwd, '.orcaops/cache/review-feedback'), { recursive: true });
    await exec('git', ['-C', f.options.cwd, 'update-ref', '-d', 'refs/orcaops/review/original'], {
      env: f.options.env,
    });
    expect((await prepareLegacySources(preview)).manifestSha256).toBe(first.manifestSha256);
    await exec('git', ['-C', f.options.cwd, 'update-ref', 'refs/orcaops/unknown/shared', 'HEAD'], {
      env: f.options.env,
    });
    await expect(prepareLegacySources(preview)).rejects.toMatchObject({ code: 'SOURCE_CHANGED' });
    await exec('git', ['-C', f.options.cwd, 'update-ref', '-d', 'refs/orcaops/unknown/shared'], {
      env: f.options.env,
    });
    await f.write('.orcaops/included.json', Buffer.from('in-scope unknown history'));
    await expect(prepareLegacySources(preview)).rejects.toMatchObject({ code: 'SOURCE_CHANGED' });
  });

  it('refuses configured shared history overlapping omitted locations without reading either payload', async () => {
    const f = await fixture();
    await f.write(
      '.orcaops/config.json',
      encode({ schema_version: 6, artifacts: { path: '.orcaops/reviews/artifacts' } })
    );
    await f.write(`.orcaops/reviews/artifacts/${artifactId}/events.ndjson`, record(plan));
    const observed = vi.spyOn(observations, 'observeLegacySourceFile');
    const preview = await previewLegacyRepository(f.options);
    expect(preview.contentComplete).toBe(false);
    expect(preview.issues).toContainEqual(
      expect.objectContaining({
        code: 'SOURCE_CONFLICT',
        reason: expect.stringContaining('in-scope history overlaps'),
      })
    );
    expect(observed.mock.calls.some(([input]) => input.relativePath.includes('reviews/'))).toBe(
      false
    );
  });
  it('keeps prepared sources identical across empty cache creation and removal', async () => {
    const f = await fixture();
    await f.write(`.orcaops/artifacts/${artifactId}/events.ndjson`, record(plan));
    const preview = await previewLegacyRepository(f.options);
    const before = await prepareLegacySources(preview);
    const cache = path.join(f.options.cwd, '.orcaops/cache');
    await fs.mkdir(cache);
    expect((await prepareLegacySources(preview)).manifestSha256).toBe(before.manifestSha256);
    await fs.rm(cache, { recursive: true });
    expect((await prepareLegacySources(preview)).manifestSha256).toBe(before.manifestSha256);
  });

  it('retains exact Source Plan cache bytes while excluded feedback appears and disappears', async () => {
    const f = await fixture();
    await f.write(`.orcaops/artifacts/${artifactId}/events.ndjson`, record(plan));
    const namespace = hash('https://cloud.example|org');
    const bytes = encode({
      schema_version: 1,
      external_id: 'plan',
      slug: 'plan',
      version_number: 1,
      title: 'Plan',
      body: 'Original body',
      content_hash: hash('Original body'),
      source_ref: null,
      base_url: 'https://cloud.example',
      org_id: 'org',
      pulled_at: 'original time',
    });
    const retained = await f.write(
      `.orcaops/cache/source-plan/pull/${namespace}/by-id/${hash('plan')}@1.json`,
      bytes
    );
    const preview = await previewLegacyRepository(f.options);
    expect(preview.contentComplete).toBe(true);
    const before = await prepareLegacySources(preview);
    await f.write('.orcaops/cache/review-feedback/invalid', Buffer.from('excluded'));
    const during = await prepareLegacySources(preview);
    expect(during.manifestSha256).toBe(before.manifestSha256);
    expect(readPreparedLegacySource(during, retained)).toEqual(bytes);
    await fs.rm(path.join(f.options.cwd, '.orcaops/cache/review-feedback'), { recursive: true });
    expect((await prepareLegacySources(preview)).manifestSha256).toBe(before.manifestSha256);
    await f.write('.orcaops/cache/unknown', Buffer.from('shared unknown history'));
    await expect(prepareLegacySources(preview)).rejects.toMatchObject({ code: 'SOURCE_CHANGED' });
  });
});
