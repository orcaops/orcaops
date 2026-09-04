import { randomUUID } from 'node:crypto';
import { access, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTempRepo, gitClient, inputFile, type TempRepo } from '@orcaops/test-harness';

import { findUnderivedRefs } from '../../src/commands/snapshots.js';
import { makeAgent } from '../support/test-agent.js';
import { effectiveConfigPath } from '../support/test-helpers.js';

/**
 * Fingerprint derive caching (results are persisted, not output-only)
 * + the underived-refs pre-prune predicate.
 */

interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function parseOk<T>(r: CliResult): T {
  expect(r.exitCode).toBe(0);
  const parsed = JSON.parse(r.stdout) as { ok: boolean };
  expect(parsed.ok).toBe(true);
  return parsed as T;
}

interface DeriveJson {
  cached?: boolean;
  verified: boolean | null;
  derived: { manifest_hash: string | null };
}

describe('fingerprint derive cache', () => {
  let repo: TempRepo;
  let dataRoot: string;
  let agent: ReturnType<typeof makeAgent>;
  let artifactId: string;

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
    dataRoot = await mkdtemp(path.join(tmpdir(), 'orcaops-fpc-data-'));
    agent = makeAgent({
      cwd: repo.path,
      env: {
        ORCAOPS_DATA_DIR: dataRoot,
        XDG_CACHE_HOME: await mkdtemp(path.join(tmpdir(), 'orcaops-fpc-cache-')),
      },
    });
    parseOk(await agent.runRaw(['init', '--json', '--no-llm']));
    const configPath = await effectiveConfigPath(repo.path);
    const config = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>;
    config.archive = { enabled: true, redact_secrets: false };
    await writeFile(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');

    const plan = parseOk<{ artifact_id: string; plan_steps: Array<{ step_id: string }> }>(
      await agent.runRaw([
        'capture',
        'plan',
        '--no-llm',
        '--input',
        inputFile(
          JSON.stringify({
            idempotency_key: `plan-${randomUUID()}`,
            task: 'fingerprint cache fixture',
            label: 'fingerprint cache fixture',
            plan_steps: [{ text: 'change a file', label: 's1' }],
            touched_scope: [],
          })
        ),
      ])
    );
    artifactId = plan.artifact_id;
    const stepId = plan.plan_steps[0].step_id;
    parseOk(
      await agent.runRaw([
        'capture',
        'checkpoint',
        'open',
        '--no-llm',
        '--input',
        inputFile(
          JSON.stringify({
            idempotency_key: `open-${randomUUID()}`,
            artifact_id: artifactId,
            declared_step_ids: [stepId],
          })
        ),
      ])
    );
    await writeFile(path.join(repo.path, 'changed.ts'), 'export const x = 1;\n', 'utf8');
    parseOk(
      await agent.runRaw([
        'capture',
        'checkpoint',
        'close',
        '--no-llm',
        '--input',
        inputFile(
          JSON.stringify({
            idempotency_key: `close-${randomUUID()}`,
            artifact_id: artifactId,
            n: 1,
            summary: 'changed a file',
            files_changed: ['changed.ts'],
            verification: [{ command: 'test fixture', exit_code: 0 }],
            completed_step_ids: [stepId],
          })
        ),
      ])
    );
  }, 60_000);

  afterEach(async () => {
    await repo.cleanup();
  });

  it('derive writes the archive cache, then reads through with identical output', async () => {
    const first = parseOk<DeriveJson>(
      await agent.runRaw([
        'fingerprint',
        'derive',
        '--artifact',
        artifactId,
        '--checkpoint',
        '1',
        '--json',
      ])
    );
    expect(first.cached).toBeUndefined();
    expect(first.verified).toBe(true);

    const projectId = (
      await gitClient(repo.path).raw(['config', '--local', '--get', 'orcaops.projectid'])
    ).trim();
    const cacheFile = path.join(
      dataRoot,
      'projects',
      projectId,
      'artifacts',
      artifactId,
      'derived',
      'fingerprint-cp1.json'
    );
    await access(cacheFile); // exists

    const second = parseOk<DeriveJson>(
      await agent.runRaw([
        'fingerprint',
        'derive',
        '--artifact',
        artifactId,
        '--checkpoint',
        '1',
        '--json',
      ])
    );
    expect(second.cached).toBe(true);
    expect(second.verified).toBe(true);
    expect(second.derived.manifest_hash).toBe(first.derived.manifest_hash);
  });

  it('a stored manifest keeps prune candidates out of the underived set', async () => {
    const prune = parseOk<{ underived: string[]; candidates: string[] }>(
      await agent.runRaw(['snapshots', 'prune', '--artifact', artifactId, '--json'])
    );
    expect(prune.candidates.length).toBeGreaterThanOrEqual(2); // open + close refs
    expect(prune.underived).toEqual([]);
  });
});

describe('findUnderivedRefs (unit)', () => {
  const REFS = [
    { ref: 'refs/orcaops/snap/a1/1/open', artifact_id: 'a1', n: 1 },
    { ref: 'refs/orcaops/snap/a1/1/close', artifact_id: 'a1', n: 1 },
    { ref: 'refs/orcaops/snap/a2/1/close', artifact_id: 'a2', n: 1 },
  ];
  const candidates = REFS.map((r) => r.ref);

  it('flags closed checkpoints with neither stored nor cached manifest', async () => {
    const underived = await findUnderivedRefs(
      {
        listParsedRefs: async () => REFS,
        readCheckpoint: async (aid) =>
          aid === 'a1'
            ? { status: 'closed', diff_fingerprint_summary: { manifest_hash: null } }
            : { status: 'closed', diff_fingerprint_summary: { manifest_hash: 'deadbeef' } },
        cachedManifestExists: async () => false,
      },
      candidates
    );
    expect(underived).toEqual(['refs/orcaops/snap/a1/1/open', 'refs/orcaops/snap/a1/1/close']);
  });

  it('a cached derived manifest un-flags the checkpoint', async () => {
    const underived = await findUnderivedRefs(
      {
        listParsedRefs: async () => REFS,
        readCheckpoint: async () => ({
          status: 'closed',
          diff_fingerprint_summary: { manifest_hash: null },
        }),
        cachedManifestExists: async (aid) => aid === 'a1',
      },
      candidates
    );
    expect(underived).toEqual(['refs/orcaops/snap/a2/1/close']);
  });

  it('absent artifacts and non-closed checkpoints are never flagged', async () => {
    const underived = await findUnderivedRefs(
      {
        listParsedRefs: async () => REFS,
        readCheckpoint: async (aid) => (aid === 'a1' ? null : { status: 'open' }),
        cachedManifestExists: async () => false,
      },
      candidates
    );
    expect(underived).toEqual([]);
  });
});
