import { randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTempRepo, gitClient, inputFile, type TempRepo } from '@orcaops/test-harness';

import { makeAgent } from '../support/test-agent.js';
import { effectiveConfigPath } from '../support/test-helpers.js';

/**
 * `archive prune`, the ONLY archive deletion path. Dry-run
 * default, warning on every output, path-containment assertion, exact
 * deletion, runs from outside any repo.
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

interface PruneJson {
  applied: boolean;
  mode: string;
  warning: string;
  candidates: Array<{ path: string; project_id: string; artifacts: number }>;
  deleted: number;
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

describe('archive prune', () => {
  let repo: TempRepo;
  let dataRoot: string;
  let outside: string;
  let env: Record<string, string>;
  let agent: ReturnType<typeof makeAgent>;
  let projectId: string;
  let artifactA: string;
  let artifactB: string;

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
    dataRoot = await mkdtemp(path.join(tmpdir(), 'orcaops-prune-data-'));
    outside = await mkdtemp(path.join(tmpdir(), 'orcaops-prune-out-'));
    env = {
      ORCAOPS_DATA_DIR: dataRoot,
      XDG_CACHE_HOME: await mkdtemp(path.join(tmpdir(), 'orcaops-prune-cache-')),
    };
    agent = makeAgent({ cwd: repo.path, env });
    parseOk(await agent.runRaw(['init', '--json', '--no-llm']));
    const configPath = await effectiveConfigPath(repo.path);
    const config = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>;
    config.archive = { enabled: true, redact_secrets: false };
    await writeFile(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');

    const capture = async (task: string): Promise<string> =>
      parseOk<{ artifact_id: string }>(
        await agent.runRaw([
          'capture',
          'plan',
          '--no-llm',
          '--input',
          inputFile(
            JSON.stringify({
              idempotency_key: `plan-${randomUUID()}`,
              task,
              label: `${task} ${randomUUID().slice(0, 6)}`,
              plan_steps: [{ text: `do ${task}`, label: 's1' }],
              touched_scope: [],
            })
          ),
        ])
      ).artifact_id;
    artifactA = await capture('first prune fixture');
    artifactB = await capture('second prune fixture');
    projectId = (
      await gitClient(repo.path).raw(['config', '--local', '--get', 'orcaops.projectid'])
    ).trim();
  }, 60_000);

  afterEach(async () => {
    await repo.cleanup();
  });

  const artifactDir = (id: string): string =>
    path.join(dataRoot, 'projects', projectId, 'artifacts', id);

  it('dry-run lists candidates with the warning and deletes nothing', async () => {
    const r = parseOk<PruneJson>(
      await agent.runRaw(['archive', 'prune', '--artifact', artifactA, '--json'])
    );
    expect(r.applied).toBe(false);
    expect(r.deleted).toBe(0);
    expect(r.warning).toContain('ONLY deletion path');
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0].project_id).toBe(projectId);
    expect(await exists(artifactDir(artifactA))).toBe(true);
  });

  it('--apply deletes exactly the selected artifact and leaves the sibling', async () => {
    const r = parseOk<PruneJson>(
      await agent.runRaw(['archive', 'prune', '--artifact', artifactA, '--apply', '--json'])
    );
    expect(r.applied).toBe(true);
    expect(r.deleted).toBe(1);
    expect(await exists(artifactDir(artifactA))).toBe(false);
    expect(await exists(artifactDir(artifactB))).toBe(true);
  });

  it('--project --apply deletes the whole project dir, from OUTSIDE any repo', async () => {
    const outsideAgent = makeAgent({ cwd: outside, env });
    const dry = parseOk<PruneJson>(
      await outsideAgent.runRaw(['archive', 'prune', '--project', projectId, '--json'])
    );
    expect(dry.candidates[0].artifacts).toBe(2);
    const r = parseOk<PruneJson>(
      await outsideAgent.runRaw(['archive', 'prune', '--project', projectId, '--apply', '--json'])
    );
    expect(r.deleted).toBe(1);
    expect(await exists(path.join(dataRoot, 'projects', projectId))).toBe(false);
  });

  it('rejects missing/double selectors and traversal-shaped ids', async () => {
    for (const args of [
      ['archive', 'prune', '--json'],
      ['archive', 'prune', '--project', projectId, '--artifact', artifactA, '--json'],
      ['archive', 'prune', '--project', '../../somewhere', '--apply', '--json'],
    ]) {
      const r = await agent.runRaw(args);
      expect(r.exitCode).not.toBe(0);
      const parsed = JSON.parse(r.stdout) as { ok: boolean; error: { code: string } };
      expect(parsed.error.code).toBe('INVALID_INPUT');
    }
    // Traversal attempt deleted nothing anywhere.
    expect(await exists(path.join(dataRoot, 'projects', projectId))).toBe(true);
  });

  it('cross-project --artifact traversal is refused independently of --project', async () => {
    // The victim is a REAL second project dir with a real artifact; the
    // attacker addresses it through the artifact selector, which historically
    // was joined beneath every project and only checked against the archive
    // ROOT — a `../..`-shaped selector stayed "inside" while landing in the
    // victim project. Selectors are now UUIDv7-validated BEFORE any path is
    // built, and containment is per-target (that project's artifacts/ dir).
    const victimProject = '019fc1ff-0000-7000-8000-0000000000ee';
    const victimArtifact = '019fc1ff-0000-7000-8000-0000000000aa';
    const victimDir = path.join(dataRoot, 'projects', victimProject, 'artifacts', victimArtifact);
    await mkdir(victimDir, { recursive: true });
    await writeFile(path.join(victimDir, 'events.ndjson'), '', 'utf8');

    for (const selector of [
      `../../${victimProject}`,
      `../../${victimProject}/artifacts/${victimArtifact}`,
      `..`,
    ]) {
      const res = await agent.runRaw([
        'archive',
        'prune',
        '--artifact',
        selector,
        '--apply',
        '--json',
      ]);
      expect(res.exitCode).toBe(1);
      const parsed = JSON.parse(res.stdout) as { ok: false; error: { code: string } };
      expect(parsed.error.code).toBe('INVALID_INPUT');
    }
    expect(await exists(victimDir)).toBe(true);

    // A legitimate UUID selector for the victim artifact, addressed as an
    // artifact id, deletes ONLY artifact dirs named exactly that id.
    const res = await agent.runRaw([
      'archive',
      'prune',
      '--artifact',
      victimArtifact,
      '--apply',
      '--json',
    ]);
    expect(res.exitCode).toBe(0);
    expect(await exists(victimDir)).toBe(false);
    expect(await exists(path.join(dataRoot, 'projects', projectId))).toBe(true);
  });
});
