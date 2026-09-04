import { randomUUID } from 'node:crypto';
import { access, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTempRepo, gitClient, inputFile, type TempRepo } from '@orcaops/test-harness';

import { makeAgent } from '../support/test-agent.js';
import { effectiveConfigPath } from '../support/test-helpers.js';

/**
 * Archive wiring end-to-end through the real CLI: enabling
 * `archive.enabled` mirrors the whole lifecycle into the (test-scoped)
 * home-dir archive and registers the project; explicit opt-out stops new
 * mirror writes without deleting archive identity; a corrupt registry never
 * fails a command (hints only, fail-open).
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

describe('archive mirror CLI wiring', () => {
  let repo: TempRepo;
  let dataRoot: string;
  let agent: ReturnType<typeof makeAgent>;

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
    dataRoot = await mkdtemp(path.join(tmpdir(), 'orcaops-archive-e2e-'));
    agent = makeAgent({ cwd: repo.path, env: { ORCAOPS_DATA_DIR: dataRoot } });
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  async function enableArchive(): Promise<void> {
    const configPath = await effectiveConfigPath(repo.path);
    const config = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>;
    config.archive = { enabled: true, redact_secrets: false };
    await writeFile(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
  }

  async function captureLifecycle(): Promise<string> {
    const plan = parseOk<{ artifact_id: string; plan_steps: Array<{ step_id: string }> }>(
      await agent.runRaw([
        'capture',
        'plan',
        '--no-llm',
        '--input',
        inputFile(
          JSON.stringify({
            idempotency_key: `plan-${randomUUID()}`,
            task: 'archive e2e',
            label: 'archive-e2e',
            plan_steps: [{ text: 'step 1', label: 's1' }],
            touched_scope: [],
          })
        ),
      ])
    );
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
            artifact_id: plan.artifact_id,
            declared_step_ids: [stepId],
          })
        ),
      ])
    );
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
            artifact_id: plan.artifact_id,
            n: 1,
            summary: 'done',
            verification: [{ command: 'test fixture', exit_code: 0 }],
            completed_step_ids: [stepId],
          })
        ),
      ])
    );
    return plan.artifact_id;
  }

  it('enabled: full lifecycle mirrors byte-identically and registers the project', async () => {
    parseOk(await agent.runRaw(['init', '--json', '--no-llm']));
    await enableArchive();
    const artifactId = await captureLifecycle();

    const projectId = (
      await gitClient(repo.path).raw(['config', '--local', '--get', 'orcaops.projectid'])
    ).trim();
    expect(projectId).toMatch(/^[0-9a-f-]{36}$/);

    const hotLog = await readFile(
      path.join(repo.path, '.orcaops', 'artifacts', artifactId, 'events.ndjson'),
      'utf8'
    );
    const archiveLog = await readFile(
      path.join(dataRoot, 'projects', projectId, 'artifacts', artifactId, 'events.ndjson'),
      'utf8'
    );
    expect(archiveLog).toBe(hotLog);
    expect(hotLog.trim().split('\n').length).toBeGreaterThanOrEqual(3);

    const registry = JSON.parse(await readFile(path.join(dataRoot, 'projects.json'), 'utf8')) as {
      schema_version: number;
      projects: Record<
        string,
        { display_name: string; last_seen_paths: string[]; root_commit_shas: string[] }
      >;
    };
    expect(registry.projects[projectId]).toBeDefined();
    // buildContext resolves the repo root through git (realpath'd), so on
    // macOS /var symlinks the registry hint carries the /private form.
    expect(registry.projects[projectId].last_seen_paths[0]).toBe(await realpath(repo.path));
    expect(registry.projects[projectId].display_name).toBe(path.basename(repo.path));
    expect(registry.projects[projectId].root_commit_shas.length).toBeGreaterThanOrEqual(1);
  });

  it('explicit opt-out stops new lifecycle mirroring while retaining project identity', async () => {
    parseOk(await agent.runRaw(['init', '--json', '--no-llm']));
    parseOk(await agent.runRaw(['archive', 'disable', '--json']));
    const registryBefore = await readFile(path.join(dataRoot, 'projects.json'), 'utf8');
    const artifactId = await captureLifecycle();
    const projectId = (
      await gitClient(repo.path).raw(['config', '--local', '--get', 'orcaops.projectid'])
    ).trim();

    expect(projectId).toMatch(/^[0-9a-f-]{36}$/);
    expect(await readFile(path.join(dataRoot, 'projects.json'), 'utf8')).toBe(registryBefore);
    await expect(
      access(path.join(dataRoot, 'projects', projectId, 'artifacts', artifactId, 'events.ndjson'))
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('corrupt registry: commands succeed and the registry self-heals', async () => {
    parseOk(await agent.runRaw(['init', '--json', '--no-llm']));
    await enableArchive();
    await writeFile(path.join(dataRoot, 'projects.json'), '{corrupt!!', 'utf8');
    await captureLifecycle();
    const registry = JSON.parse(await readFile(path.join(dataRoot, 'projects.json'), 'utf8')) as {
      projects: Record<string, unknown>;
    };
    expect(Object.keys(registry.projects)).toHaveLength(1);
  });
});
