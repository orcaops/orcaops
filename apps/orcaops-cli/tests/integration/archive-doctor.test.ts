import { randomUUID } from 'node:crypto';
import { appendFile, chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Repo } from '@orcaops/core';
import { type Registry, registryPath, saveRegistry } from '@orcaops/storage';
import { createTempRepo, gitClient, inputFile, type TempRepo } from '@orcaops/test-harness';

import { regrantCommandFor } from '../../src/commands/eval/add-pack.js';
import { makeAgent } from '../support/test-agent.js';

/**
 * Archive doctor checks + two remediation-hint fixes (push-status
 * hyphen; eval add-pack full-source form).
 */

interface DoctorJson {
  ok: boolean;
  overall: string;
  checks: Array<{ name: string; status: string; summary: string; details?: string[] }>;
}

function check(
  r: DoctorJson,
  name: string
): { status: string; summary: string; details?: string[] } {
  const c = r.checks.find((x) => x.name === name);
  expect(c, `check ${name} present`).toBeDefined();
  return c as { status: string; summary: string; details?: string[] };
}

describe('archive doctor checks', () => {
  let repo: TempRepo;
  let dataRoot: string;
  let agent: ReturnType<typeof makeAgent>;

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
    dataRoot = await mkdtemp(path.join(tmpdir(), 'orcaops-adoc-data-'));
    agent = makeAgent({
      cwd: repo.path,
      env: {
        CLAUDE_SESSION_ID: 'archive-doctor-test',
        ORCAOPS_DATA_DIR: dataRoot,
        XDG_CACHE_HOME: await mkdtemp(path.join(tmpdir(), 'orcaops-adoc-cache-')),
      },
    });
    // Project scope keeps the global-install check out of play: this suite
    // re-keys the repo identity mid-test, which under personal scope would
    // correctly orphan the per-user materialization and warn.
    const init = await agent.runRaw(['init', '--scope', 'project', '--json', '--no-llm']);
    expect(init.exitCode).toBe(0);
  }, 60_000);

  afterEach(async () => {
    await repo.cleanup();
  });

  async function setArchiveEnabled(enabled: boolean): Promise<void> {
    const configPath = path.join(repo.path, '.orcaops', 'config.json');
    const config = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>;
    config.archive = { enabled, redact_secrets: false };
    await writeFile(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
  }

  async function capturePlan(): Promise<string> {
    const r = await agent.runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--input',
      inputFile(
        JSON.stringify({
          idempotency_key: `plan-${randomUUID()}`,
          task: 'doctor fixture',
          label: `doctor fixture ${randomUUID().slice(0, 6)}`,
          plan_steps: [{ text: 'do it', label: 's1' }],
          touched_scope: [],
        })
      ),
    ]);
    expect(r.exitCode).toBe(0);
    return (JSON.parse(r.stdout) as { artifact_id: string }).artifact_id;
  }

  async function doctor(): Promise<DoctorJson> {
    const r = await agent.runRaw(['doctor', '--json']);
    return JSON.parse(r.stdout) as DoctorJson;
  }

  it('reports retained history without warning and keeps enabled identity drift actionable', async () => {
    // Default-ON init may have backfilled under the original id, so shed it:
    // the capture mints a FRESH projectid with nothing mirrored under it →
    // still the single pass check; the warn keys on mirrored HISTORY.
    await setArchiveEnabled(false);
    await gitClient(repo.path).raw(['config', '--local', '--unset', 'orcaops.projectid']);
    await capturePlan();
    const d = await doctor();
    expect(check(d, 'archive').status).toBe('pass');
    expect(check(d, 'archive').summary).toContain('disabled');

    await agent.runRaw(['archive', 'enable', '--json']);
    await capturePlan();
    await agent.runRaw(['archive', 'disable', '--json']);
    const disabled = await doctor();
    const retained = check(disabled, 'archive');
    const projectId = (
      await gitClient(repo.path).raw(['config', '--local', '--get', 'orcaops.projectid'])
    ).trim();
    expect(disabled.checks.filter((candidate) => candidate.status !== 'pass')).toEqual([]);
    expect(disabled.overall).toBe('pass');
    expect(retained.status).toBe('pass');
    expect(retained.summary).toContain(path.join(dataRoot, 'projects', projectId));
    expect((retained.details ?? []).join('\n')).toContain('orcaops archive enable');
    expect((retained.details ?? []).join('\n')).toContain('delete that directory');
    const human = await agent.runRaw(['doctor']);
    expect(human.stdout).toContain(path.join(dataRoot, 'projects', projectId));
    expect(human.stdout).toContain('orcaops archive enable');
    expect(human.stdout).toContain('delete that directory');

    await agent.runRaw(['archive', 'enable', '--json']);
    await gitClient(repo.path).raw(['config', '--local', '--unset', 'orcaops.projectid']);
    const drifted = await doctor();
    const identity = check(drifted, 'archive-identity');
    expect(identity.status).toBe('warn');
    expect(identity.summary).toContain('no project identity');
  });

  it('healthy enabled repo: identity/lag/perms/index checks pass; lag warns after off-capture', async () => {
    await setArchiveEnabled(true);
    await capturePlan();
    const d = await doctor();
    expect(check(d, 'archive-identity').status).toBe('pass');
    expect(check(d, 'archive-mirror-lag').status).toBe('pass');
    expect(check(d, 'archive-perms').status).toBe('pass');
    expect(check(d, 'archive-index').status).toBe('pass');
    expect(check(d, 'archive-manifest-derivation').status).toBe('pass');

    // Lag: capture with archive off, re-enable → doctor warns with the hint.
    await setArchiveEnabled(false);
    await capturePlan();
    await setArchiveEnabled(true);
    const lagging = await doctor();
    const lag = check(lagging, 'archive-mirror-lag');
    expect(lag.status).toBe('warn');
    expect((lag.details ?? []).join('\n')).toContain('orcaops archive repair');
  });

  it('suggests the one archive identity matching the current repository', async () => {
    await setArchiveEnabled(true);
    await gitClient(repo.path).raw(['config', '--local', '--unset', 'orcaops.projectid']);
    const candidateId = '019fc100-0000-7000-8000-00000000aaa1';
    const [rootCommit] = await new Repo(repo.path).getRootCommitShas();
    const registry: Registry = {
      schema_version: 1,
      projects: {
        [candidateId]: {
          display_name: 'archived fixture',
          last_seen_paths: [],
          remotes: [],
          root_commit_shas: [rootCommit],
          last_seen_at: '2026-08-08T00:00:00.000Z',
        },
      },
    };
    await saveRegistry(registryPath(dataRoot), registry);
    // The suggestion only applies to a repo with no minted identity, and init
    // mints one eagerly — drop it so the adopt-this-archive hint is reachable.
    await gitClient(repo.path).raw(['config', '--local', '--unset', 'orcaops.projectid']);

    const d = await doctor();
    const identity = check(d, 'archive-identity');
    expect(identity.status).toBe('warn');
    expect((identity.details ?? []).join('\n')).toContain(
      `git config --local orcaops.projectid ${candidateId}`
    );
    expect((identity.details ?? []).join('\n')).not.toContain('Any capture command mints it');
    expect(await new Repo(repo.path).getLocalConfig('orcaops.projectid')).toBeNull();
  });

  it('reports an invalid project identity without aborting the remaining checks', async () => {
    await setArchiveEnabled(true);
    await new Repo(repo.path).setLocalConfig('orcaops.projectid', '../../victim');
    const d = await doctor();
    const identity = check(d, 'archive-identity');
    expect(identity.status).toBe('fail');
    expect(identity.summary).toContain('not a canonical UUIDv7 project id');
    expect(identity.summary).toContain('git config --local --unset orcaops.projectid');
    expect(check(d, 'review-cache-integrity').status).toBe('pass');

    const status = await agent.runRaw(['archive', 'status', '--json']);
    expect(status.exitCode).toBe(1);
    const statusError = JSON.parse(status.stdout) as {
      error: { code: string; message: string };
    };
    expect(statusError.error.code).toBe('INVALID_INPUT');
    expect(statusError.error.message).toContain('not a canonical UUIDv7 project id');
  });

  it('classifies an unreadable project identity from a subdirectory', async () => {
    await setArchiveEnabled(true);
    await capturePlan();
    const nested = path.join(repo.path, 'nested');
    await mkdir(nested);
    const configPath = path.join(repo.path, '.git', 'config');
    const healthyConfig = await readFile(configPath);
    await writeFile(configPath, '[broken\n', 'utf8');
    const nestedAgent = makeAgent({
      cwd: nested,
      env: {
        ORCAOPS_DATA_DIR: dataRoot,
        XDG_CACHE_HOME: await mkdtemp(path.join(tmpdir(), 'orcaops-adoc-nested-cache-')),
      },
    });

    try {
      const doctorResult = await nestedAgent.runRaw(['doctor', '--json']);
      expect(doctorResult.exitCode).toBe(1);
      const report = JSON.parse(doctorResult.stdout) as DoctorJson;
      expect(check(report, 'archive-identity')).toMatchObject({
        status: 'fail',
        summary: expect.stringContaining('could not read git config orcaops.projectid'),
      });
      expect(check(report, 'review-cache-integrity').status).toBe('pass');

      const status = await nestedAgent.runRaw(['archive', 'status', '--json']);
      expect(status.exitCode).toBe(1);
      expect(JSON.parse(status.stdout)).toMatchObject({
        error: {
          code: 'INVALID_INPUT',
          message: expect.stringContaining('could not read git config orcaops.projectid'),
        },
      });
    } finally {
      await writeFile(configPath, healthyConfig);
    }
  });

  it('loose perms warn with a chmod hint', async () => {
    await setArchiveEnabled(true);
    await capturePlan();
    await chmod(dataRoot, 0o755);
    const d = await doctor();
    const perms = check(d, 'archive-perms');
    expect(perms.status).toBe('warn');
    expect((perms.details ?? []).join('\n')).toContain('chmod 700');
  });

  it('content-blocked mirror lag warns with the applicable explicit resolution command', async () => {
    await setArchiveEnabled(true);
    const artifactId = await capturePlan();
    await appendFile(
      path.join(repo.path, '.orcaops', 'artifacts', artifactId, 'events.ndjson'),
      '{"truncated":',
      'utf8'
    );

    const d = await doctor();
    const lag = check(d, 'archive-mirror-lag');

    expect(lag.status).toBe('warn');
    expect(lag.summary).toContain('1 artifact(s) blocked');
    expect((lag.details ?? []).join('\n')).toContain(
      `orcaops archive resolve --artifact ${artifactId} --source archive --apply`
    );
  });

  it('does not suggest an automated resolution when neither source validates', async () => {
    await setArchiveEnabled(true);
    const artifactId = await capturePlan();
    const status = await agent.runRaw(['archive', 'status', '--json']);
    const { project_dir: projectDir } = JSON.parse(status.stdout) as {
      project_dir: string;
    };
    await appendFile(
      path.join(repo.path, '.orcaops', 'artifacts', artifactId, 'events.ndjson'),
      '{"truncated":',
      'utf8'
    );
    await appendFile(
      path.join(projectDir, 'artifacts', artifactId, 'events.ndjson'),
      '{"truncated":',
      'utf8'
    );

    const d = await doctor();
    const lag = check(d, 'archive-mirror-lag');
    const details = (lag.details ?? []).join('\n');
    expect(details).toContain('no automated resolution: neither source strictly reconstructs');
    expect(details).not.toContain(`--artifact ${artifactId} --source`);
  });

  it('a CACHEDIR.TAG inside the precious archive root warns loudly', async () => {
    await setArchiveEnabled(true);
    await capturePlan();
    await writeFile(
      path.join(dataRoot, 'CACHEDIR.TAG'),
      'Signature: 8a477f597d28d172789f06886806bc55\n',
      'utf8'
    );
    const d = await doctor();
    const idx = check(d, 'archive-index');
    expect(idx.status).toBe('warn');
    expect(idx.summary).toContain('PRECIOUS');
  });
});

describe('remediation-hint fixes', () => {
  it('regrantCommandFor builds invocations add-pack actually parses', () => {
    // Bundled first-party pack: bare `add-pack core` INVALID_INPUTs; the
    // full source form is source + pack id.
    expect(
      regrantCommandFor(
        { kind: 'bundled', package: '@orcaops/evaluator-pack', pack: 'core' },
        'core'
      )
    ).toBe('orcaops eval add-pack @orcaops/evaluator-pack core --force --yes');
    expect(regrantCommandFor({ kind: 'package', package: 'some-pkg', pack: 'p1' }, 'p1')).toBe(
      'orcaops eval add-pack some-pkg p1 --force --yes'
    );
    expect(regrantCommandFor({ kind: 'path', path: './packs/local' }, 'local')).toBe(
      'orcaops eval add-pack ./packs/local --force --yes'
    );
    expect(regrantCommandFor(undefined, 'mystery')).toBe(
      'orcaops eval add-pack <source> mystery --force --yes'
    );
  });

  it('a bare pack id is rejected with INVALID_INPUT', async () => {
    const repo = await createTempRepo({ initialBranch: 'main' });
    try {
      const agent = makeAgent({ cwd: repo.path });
      await agent.runRaw(['init', '--json', '--no-llm']);
      const r = await agent.runRaw(['eval', 'add-pack', 'core', '--force', '--yes', '--json']);
      expect(r.exitCode).not.toBe(0);
      const parsed = JSON.parse(r.stdout) as { ok: boolean; error: { code: string } };
      expect(parsed.error.code).toBe('INVALID_INPUT');
    } finally {
      await repo.cleanup();
    }
  });

  it('doctor hints use the hyphenated command and the full source form', async () => {
    const src = await readFile(new URL('../../src/commands/doctor.ts', import.meta.url), 'utf8');
    // The cloud-push queue is a HYPHENATED top-level command. The space form is
    // the trap: `push` is itself a command, so `orcaops push status` parses as
    // `push` with a stray argument rather than failing loudly.
    expect(src).not.toContain('orcaops push status');
    expect(src).not.toContain('orcaops sync status');
    expect(src).not.toContain('add-pack ${pack_id} --force');
  });
});
