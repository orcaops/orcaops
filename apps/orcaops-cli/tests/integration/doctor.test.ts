import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTempRepo, type TempRepo } from '@orcaops/test-harness';

import { sanitizeDoctorChecks } from '../../src/commands/doctor.js';
import { fixture as databaseFixture } from '../helpers/database-history.js';
import { makeAgent } from '../support/test-agent.js';
import { effectiveConfigPath, TEST_PACK_ABS_PATH } from '../support/test-helpers.js';

interface DoctorReport {
  ok: true;
  overall: 'pass' | 'warn' | 'fail';
  orcaops_version: string;
  repo_root: string;
  checks: Array<{
    name: string;
    status: 'pass' | 'warn' | 'fail';
    summary: string;
    details?: string[];
  }>;
}

function findCheck(report: DoctorReport, name: string): DoctorReport['checks'][number] {
  const c = report.checks.find((x) => x.name === name);
  if (!c) throw new Error(`No check named "${name}" in report`);
  return c;
}

describe('orcaops doctor', () => {
  it('scrubs every check summary and detail before returning the report', () => {
    const token = 'ghp_0000000000000000000000000000000000000';
    const oversized = 'x'.repeat(20_000);
    const esc = String.fromCharCode(0x1b);
    const csi = String.fromCharCode(0x9b);
    const ansiSplit = `${token.slice(0, 20)}${esc}[31m${token.slice(20)}`;
    const csiSplit = `${token.slice(0, 20)}${csi}31m${token.slice(20)}`;
    const [check] = sanitizeDoctorChecks([
      {
        name: 'upstream-error',
        status: 'fail',
        summary: `request failed with ${ansiSplit} ${oversized}`,
        details: [`response body: ${csiSplit} ${oversized}`],
      },
    ]);

    expect(check?.summary).not.toContain(token);
    expect(check?.details?.join('\n')).not.toContain(token);
    expect(check?.summary).toContain('[REDACTED_SECRET]');
    expect(check?.details?.join('\n')).toContain('[REDACTED_SECRET]');
    expect(check?.summary).toContain('[truncated]');
    expect(check?.details?.join('\n')).toContain('[truncated]');
    expect(check?.summary.length).toBeLessThanOrEqual(8192);
    expect(check?.details?.[0]?.length).toBeLessThanOrEqual(8192);
    expect(check?.summary).not.toContain(esc);
    expect(check?.details?.join('\n')).not.toContain(csi);
  });

  let repo: TempRepo;
  let agent: ReturnType<typeof makeAgent>;

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
    // Inject CLAUDE_SESSION_ID so the `shell-key` doctor check
    // resolves to `claude_session` rather than `none`. This file
    // tests the *other* doctor checks; shell-key warn-vs-pass is
    // covered explicitly in doctor-pins.test.ts.
    agent = makeAgent({
      cwd: repo.path,
      env: {
        CLAUDE_SESSION_ID: 'test-doctor',
        ORCAOPS_CLOUD_FEATURES: '1',
        ORCAOPS_CONFIG_HOME: path.join(repo.path, '.test-config-home'),
      },
    });
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it('on uninitialized repo: git-repo passes; init + config fail; overall=fail; exit=1', async () => {
    const res = await agent.runRaw(['doctor', '--json']);
    expect(res.exitCode).toBe(1);
    const r = JSON.parse(res.stdout) as DoctorReport;
    expect(r.overall).toBe('fail');
    expect(findCheck(r, 'git-repo').status).toBe('pass');
    expect(findCheck(r, 'init').status).toBe('fail');
    expect(findCheck(r, 'config').status).toBe('fail');
    // Subsequent checks (which depend on config) are skipped, not added.
    expect(r.checks.find((c) => c.name === 'cache')).toBeUndefined();
    expect(r.checks.find((c) => c.name === 'agent-skills')).toBeUndefined();
  });

  it('on a non-git directory: git-repo fails', async () => {
    const token = 'ghp_0000000000000000000000000000000000000';
    const tmp = await mkdtemp(path.join(tmpdir(), `orcaops-doctor-${token}-`));
    try {
      const noGitAgent = makeAgent({ cwd: tmp, env: { CLAUDE_SESSION_ID: 'test-doctor' } });
      const res = await noGitAgent.runRaw(['doctor', '--json']);
      expect(res.exitCode).toBe(1);
      const r = JSON.parse(res.stdout) as DoctorReport;
      const check = findCheck(r, 'git-repo');
      expect(check.status).toBe('fail');
      expect(JSON.stringify(check)).not.toContain(token);
      expect(JSON.stringify(check)).toContain('[REDACTED_SECRET]');
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('after init, history coverage is the only warning until seed or live capture', async () => {
    const init = await agent.runRaw(['init', '--scope', 'project', '--json', '--no-llm']);
    expect(init.exitCode).toBe(0);

    const res = await agent.runRaw(['doctor', '--json']);
    expect(res.exitCode, res.stdout + res.stderr).toBe(0);
    const r = JSON.parse(res.stdout) as DoctorReport;
    expect(r.overall).toBe('warn');
    for (const check of r.checks.filter((check) => check.name !== 'seed')) {
      if (check.status !== 'pass') {
        throw new Error(`Expected pass; ${check.name} = ${check.status}: ${check.summary}`);
      }
    }
    // Sanity: the watchdog checks ARE present (folded in from the hook roles).
    expect(findCheck(r, 'stale-artifacts').status).toBe('pass');
    expect(findCheck(r, 'unresolved-blocks').status).toBe('pass');
    expect(findCheck(r, 'seed').status).toBe('warn');
  });

  it('leaves retired artifact-deletion staging untouched and omits its old check', async () => {
    const init = await agent.runRaw(['init', '--scope', 'project', '--json', '--no-llm']);
    expect(init.exitCode).toBe(0);
    const artifactId = '01999999-9999-7000-8000-0000000000f1';
    const staged = path.join(
      repo.path,
      '.orcaops',
      'tmp',
      'artifact-deletions',
      artifactId,
      'prepared-01999999-9999-7000-8000-0000000000f2'
    );
    await mkdir(staged, { recursive: true });
    await writeFile(path.join(staged, 'events.ndjson'), 'protected\n', 'utf8');

    const res = await agent.runRaw(['doctor', '--json']);
    const report = JSON.parse(res.stdout) as DoctorReport;
    expect(report.checks.some((check) => check.name === 'artifact-deletion-recovery')).toBe(false);
    await expect(readFile(path.join(staged, 'events.ndjson'), 'utf8')).resolves.toBe('protected\n');
  });

  it('with additional agents, install checks pass and status labels are surfaced', async () => {
    const init = await agent.runRaw([
      'init',
      '--scope',
      'project',
      '--agents',
      'cursor,opencode,aider-desk,github-copilot,antigravity-cli',
      '--json',
      '--no-llm',
    ]);
    expect(init.exitCode).toBe(0);

    const res = await agent.runRaw(['doctor', '--json']);
    expect(res.exitCode).toBe(0);
    const r = JSON.parse(res.stdout) as DoctorReport;
    expect(r.overall).toBe('warn');
    const skills = findCheck(r, 'agent-skills');
    expect(skills.status).toBe('pass');
    // Doctor surfaces each adapter's honest support level.
    expect(skills.summary).toContain('cursor (experimental)');
    expect(skills.summary).toContain('opencode (beta)');
    expect(skills.summary).toContain('aider-desk (experimental)');
    expect(skills.summary).toContain('github-copilot (experimental)');
    expect(skills.summary).toContain('antigravity-cli (beta)');
  });

  it('human output surfaces registered history and seed guidance without retired archive checks', async () => {
    const history = await databaseFixture();
    try {
      const databaseAgent = makeAgent({
        cwd: history.main,
        env: {
          CLAUDE_SESSION_ID: 'database-human-output',
          ORCAOPS_CLOUD_FEATURES: '0',
          ORCAOPS_DATA_DIR: history.root,
          ORCAOPS_DISABLE_DRAIN: '1',
        },
      });
      await databaseAgent.runRaw(['init', '--scope', 'project', '--no-llm', '--agents-md']);

      const result = await databaseAgent.runRaw(['doctor', '--verbose']);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('✓ history-database');
      expect(result.stdout).toContain('⚠ seed');
      expect(result.stdout).toContain('Preview with `orcaops seed --dry-run`');
      expect(result.stdout).not.toContain('archive-redaction');
      expect(result.stdout).not.toContain('archive mirror');
      expect(result.stdout).toMatch(/^Overall: WARN/m);
    } finally {
      await history.cleanup();
    }
  });

  it('--verbose restores every passing row and does not alter JSON output', async () => {
    await agent.runRaw(['init', '--scope', 'project', '--no-llm', '--agents-md']);
    const compactJson = await agent.runRaw(['doctor', '--json']);
    const verboseJson = await agent.runRaw(['doctor', '--json', '--verbose']);
    expect(JSON.parse(verboseJson.stdout)).toEqual(JSON.parse(compactJson.stdout));

    const report = JSON.parse(compactJson.stdout) as DoctorReport;
    const verbose = await agent.runRaw(['doctor', '--verbose']);
    expect(verbose.exitCode).toBe(0);
    for (const check of report.checks) {
      const marker = check.status === 'pass' ? '✓' : check.status === 'warn' ? '⚠' : '✗';
      expect(verbose.stdout).toContain(`${marker} ${check.name}`);
    }
  });

  it('human output: ⚠ marker + WARN tail line when a skill file is missing', async () => {
    await agent.runRaw(['init', '--scope', 'project', '--no-llm', '--agents-md']);
    await rm(path.join(repo.path, '.claude', 'skills', 'orcaops-summary', 'SKILL.md'));
    const res = await agent.runRaw(['doctor']);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toMatch(/⚠ agent-skills/);
    expect(res.stdout).toMatch(/^Overall: WARN \(\d+ warning\(s\)\)$/m);
  });

  it('human output: ✗ markers + FAIL tail line on an uninitialized repo', async () => {
    const res = await agent.runRaw(['doctor']);
    expect(res.exitCode).toBe(1);
    expect(res.stdout).toMatch(/✗ init/);
    expect(res.stdout).toMatch(/✗ config/);
    expect(res.stdout).toMatch(/^Overall: FAIL \(\d+ failure\(s\), \d+ warning\(s\)\)$/m);
  });

  it('agent-skills warns (not fails) when a skill file is missing', async () => {
    await agent.runRaw(['init', '--scope', 'project', '--no-llm']);
    await rm(path.join(repo.path, '.claude', 'skills', 'orcaops-summary', 'SKILL.md'));

    const res = await agent.runRaw(['doctor', '--json']);
    expect(res.exitCode).toBe(0); // warn, not fail
    const r = JSON.parse(res.stdout) as DoctorReport;
    expect(r.overall).toBe('warn');
    const check = findCheck(r, 'agent-skills');
    expect(check.status).toBe('warn');
    expect(check.summary).toMatch(/1 missing/);
    expect(check.details?.some((d) => d.includes('orcaops-summary/SKILL.md'))).toBe(true);
    expect(check.details?.some((d) => d.includes('orcaops update'))).toBe(true);
  });

  it('agent-skills warns when generatedBy stamp is stale (mismatched orcaops version)', async () => {
    await agent.runRaw(['init', '--scope', 'project', '--no-llm']);
    const skillPath = path.join(repo.path, '.claude', 'skills', 'orcaops-checkpoint', 'SKILL.md');
    const original = await readFile(skillPath, 'utf8');
    await writeFile(
      skillPath,
      original.replace(/orcaops@[^"]+/, 'orcaops@0.0.0-stale-test'),
      'utf8'
    );

    const res = await agent.runRaw(['doctor', '--json']);
    expect(res.exitCode).toBe(0);
    const r = JSON.parse(res.stdout) as DoctorReport;
    const check = findCheck(r, 'agent-skills');
    expect(check.status).toBe('warn');
    expect(check.summary).toMatch(/1 stale/);
    expect(check.details?.some((d) => d.includes('0.0.0-stale-test'))).toBe(true);
  });

  it('reports a generated-file symlink as missing without inspecting its target', async () => {
    await agent.runRaw(['init', '--scope', 'project', '--no-llm']);
    const managed = path.join(repo.path, '.claude', 'skills', 'orcaops-checkpoint', 'SKILL.md');
    const outside = await mkdtemp(path.join(tmpdir(), 'orcaops-doctor-outside-'));
    const external = path.join(outside, 'SKILL.md');
    const externalBody = 'generatedBy: "orcaops@0.0.0-stale"\nexternal\n';
    await writeFile(external, externalBody, 'utf8');
    await rm(managed);
    await symlink(external, managed);

    try {
      const res = await agent.runRaw(['doctor', '--json']);
      expect(res.exitCode).toBe(0);
      const report = JSON.parse(res.stdout) as DoctorReport;
      const check = findCheck(report, 'agent-skills');
      expect(check.status).toBe('warn');
      expect(check.summary).toMatch(/missing/);
      expect(await readFile(external, 'utf8')).toBe(externalBody);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('doctor --fix reports an unsafe install tree as a failed fix check', async () => {
    await agent.runRaw(['init', '--scope', 'project', '--no-llm']);
    const outside = await mkdtemp(path.join(tmpdir(), 'orcaops-doctor-fix-outside-'));
    await rm(path.join(repo.path, '.claude'), { recursive: true });
    await symlink(outside, path.join(repo.path, '.claude'));

    try {
      const res = await agent.runRaw(['doctor', '--fix', '--json']);
      expect(res.exitCode).toBe(1);
      const report = JSON.parse(res.stdout) as DoctorReport;
      expect(report.ok).toBe(true);
      const check = findCheck(report, 'fix');
      expect(check.status).toBe('fail');
      expect(check.summary).toMatch(/safely inspect/);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('doctor --fix reports preserved non-regular instruction entries', async () => {
    await agent.runRaw(['init', '--scope', 'project', '--no-llm', '--agents-md']);
    await rm(path.join(repo.path, 'CLAUDE.md'), { force: true });
    await rm(path.join(repo.path, 'AGENTS.md'));
    await mkdir(path.join(repo.path, 'AGENTS.md'));

    const res = await agent.runRaw(['doctor', '--fix', '--json']);

    expect(res.exitCode).toBe(0);
    const report = JSON.parse(res.stdout) as DoctorReport;
    const fix = findCheck(report, 'fix');
    expect(fix.status).toBe('warn');
    expect(fix.details).toContain('  ! AGENTS.md is not a regular file; preserving it unchanged.');
    expect(findCheck(report, 'block-skill-refs').status).toBe('pass');
    expect(await readFile(path.join(repo.path, 'CLAUDE.md'), 'utf8')).toContain(
      '<!-- orcaops:start'
    );
  });

  it.each([
    { args: [] as string[], mode: 'plain doctor' },
    { args: ['--fix'], mode: 'doctor --fix' },
  ])('returns named failed checks for unsafe evaluator paths in $mode', async ({ args }) => {
    // Project scope: the evaluator registration under test is the worktree file.
    await agent.runRaw(['init', '--scope', 'project', '--no-llm']);
    const outside = await mkdtemp(path.join(tmpdir(), 'orcaops-doctor-evaluators-'));
    const externalConfig = path.join(outside, 'evaluators.yaml');
    const configPath = path.join(repo.path, '.orcaops', 'evaluators.yaml');
    await writeFile(externalConfig, 'schema: orcaops.evaluator_config/v2\n', 'utf8');
    await rm(configPath, { force: true });
    await symlink(externalConfig, configPath);

    try {
      const res = await agent.runRaw(['doctor', ...args, '--json']);
      expect(res.exitCode).toBe(1);
      const report = JSON.parse(res.stdout) as DoctorReport;
      expect(report.ok).toBe(true);
      expect(findCheck(report, 'evaluators').status).toBe('fail');
      expect(findCheck(report, 'command-evaluator-trust').status).toBe('fail');
      expect(await readFile(externalConfig, 'utf8')).toBe('schema: orcaops.evaluator_config/v2\n');
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('agent-skills warns "newer-than-CLI" for an AHEAD stamp, without advising orcaops update', async () => {
    await agent.runRaw(['init', '--scope', 'project', '--no-llm', '--agents-md']);
    const skillPath = path.join(repo.path, '.claude', 'skills', 'orcaops-checkpoint', 'SKILL.md');
    const original = await readFile(skillPath, 'utf8');
    await writeFile(skillPath, original.replace(/orcaops@[^"]+/, 'orcaops@99.0.0'), 'utf8');

    const res = await agent.runRaw(['doctor', '--json']);
    expect(res.exitCode).toBe(0);
    const r = JSON.parse(res.stdout) as DoctorReport;
    const check = findCheck(r, 'agent-skills');
    expect(check.status).toBe('warn');
    expect(check.summary).toMatch(/1 newer-than-CLI/);
    expect(check.summary).toMatch(/0 stale/);
    expect(check.details?.some((d) => d.includes('99.0.0'))).toBe(true);
    expect(check.details?.some((d) => d.includes('upgrade orcaops'))).toBe(true);
    expect(check.details?.some((d) => d.startsWith('Run `orcaops update`'))).toBe(false);
  });

  it('agents-md warns "newer-than-CLI" for an AHEAD block stamp', async () => {
    await agent.runRaw(['init', '--scope', 'project', '--no-llm', '--agents-md']);
    const agentsPath = path.join(repo.path, 'AGENTS.md');
    const original = await readFile(agentsPath, 'utf8');
    await writeFile(
      agentsPath,
      original.replace(/orcaops:start v=[^\s]+/, 'orcaops:start v=99.0.0'),
      'utf8'
    );

    const res = await agent.runRaw(['doctor', '--json']);
    expect(res.exitCode).toBe(0);
    const r = JSON.parse(res.stdout) as DoctorReport;
    const check = findCheck(r, 'agents-md');
    expect(check.status).toBe('warn');
    // CLAUDE.md symlinks to AGENTS.md, so both files carry the ahead stamp.
    expect(check.summary).toMatch(/0 missing, 0 stale, \d+ newer-than-CLI/);
    expect(check.details?.some((d) => d.includes('upgrade orcaops'))).toBe(true);
  });

  it('agents-md classifies a MALFORMED ahead block as newer-than-CLI, not missing', async () => {
    await agent.runRaw(['init', '--scope', 'project', '--no-llm', '--agents-md']);
    const agentsPath = path.join(repo.path, 'AGENTS.md');
    const original = await readFile(agentsPath, 'utf8');
    await writeFile(
      agentsPath,
      original
        .replace(/orcaops:start v=[^\s]+/, 'orcaops:start v=99.0.0')
        .replace(/<!-- orcaops:end -->/, ''),
      'utf8'
    );

    const res = await agent.runRaw(['doctor', '--json']);
    expect(res.exitCode).toBe(0);
    const r = JSON.parse(res.stdout) as DoctorReport;
    const check = findCheck(r, 'agents-md');
    expect(check.status).toBe('warn');
    expect(check.summary).toMatch(/0 missing, 0 stale, \d+ newer-than-CLI/);
    expect(check.details?.some((d) => d.includes('upgrade orcaops'))).toBe(true);
  });

  it('agent-skills passes when the install set is empty (manual mode is a legitimate config)', async () => {
    // an explicitly empty `--agents ''` seeds an EMPTY install set:
    // nothing is installed. doctor keys install-health off install.agents now.
    await agent.runRaw(['init', '--scope', 'project', '--agents', '', '--no-llm']);

    const res = await agent.runRaw(['doctor', '--json']);
    expect(res.exitCode).toBe(0);
    const r = JSON.parse(res.stdout) as DoctorReport;
    expect(findCheck(r, 'agent-skills').status).toBe('pass');
    expect(findCheck(r, 'agent-skills').summary).toMatch(/no install agents/);
  });

  it('evaluators warns (not fails) when an installed pack has an unparseable spec', async () => {
    // New architecture: evaluators live in installed packs, not in
    // `.orcaops/evaluators/*.md`. Copy the workspace test-pack to a
    // temp dir, install it cleanly, THEN mutate one spec to become
    // unparseable on disk. validatePack re-reads from disk on every
    // doctor run, so the post-install mutation surfaces as a warn.
    // (Install-time mutation is rejected by add-pack's validation.)
    await agent.runRaw(['init', '--scope', 'project', '--no-llm']);
    const tmpParent = await mkdtemp(path.join(tmpdir(), 'orcaops-broken-pack-'));
    const packDir = path.join(tmpParent, 'broken-pack');
    const { cp } = await import('node:fs/promises');
    await cp(TEST_PACK_ABS_PATH, packDir, { recursive: true });
    const addPack = await agent.runRaw(['eval', 'add-pack', packDir, '--yes', '--json']);
    expect(addPack.exitCode).toBe(0);

    // Mutate one spec post-install: invalid severity literal that
    // makes the zod parse fail at validatePack-time.
    const brokenSpec = path.join(packDir, 'evaluators', 'api-stub.eval.yaml');
    await writeFile(
      brokenSpec,
      'schema: orcaops.evaluator/v1\nid: api-stub\nphase: checkpoint-close\nseverity: not-a-real-severity\ndescription: broken\nengine:\n  kind: command\n  command: [node, ./runtime/api-stub.mjs]\n',
      'utf8'
    );

    const res = await agent.runRaw(['doctor', '--json']);
    try {
      const r = JSON.parse(res.stdout) as DoctorReport;
      const check = findCheck(r, 'evaluators');
      expect(check.status).toBe('warn');
      expect(check.summary).toMatch(/install\/discovery issue|spec_load|failed/i);
      expect(check.details?.some((d) => d.includes('api-stub') || d.includes('broken'))).toBe(true);
    } finally {
      await rm(tmpParent, { recursive: true, force: true });
    }
  });

  it('evaluators reports "no evaluator packs installed" on a fresh init', async () => {
    // init does not install evaluator packs. The doctor check surfaces a
    // friendly pass summary directing the user to
    // `orcaops eval add-pack <source>`.
    await agent.runRaw(['init', '--scope', 'project', '--no-llm']);

    const res = await agent.runRaw(['doctor', '--json']);
    const r = JSON.parse(res.stdout) as DoctorReport;
    const check = findCheck(r, 'evaluators');
    expect(check.status).toBe('pass');
    expect(check.summary).toMatch(/no evaluator packs installed/);
    expect(check.summary).toMatch(/orcaops eval add-pack/);
  });

  it('ignores the retired file cache and reads registered database history', async () => {
    const history = await databaseFixture();
    try {
      const databaseAgent = makeAgent({
        cwd: history.main,
        env: {
          CLAUDE_SESSION_ID: 'database-cache-retirement',
          ORCAOPS_CLOUD_FEATURES: '0',
          ORCAOPS_DATA_DIR: history.root,
          ORCAOPS_DISABLE_DRAIN: '1',
        },
      });
      await databaseAgent.runRaw(['init', '--scope', 'project', '--no-llm']);
      const legacyCache = path.join(history.main, '.orcaops', 'cache', 'orcaops.db');
      await mkdir(path.dirname(legacyCache), { recursive: true });
      await writeFile(legacyCache, 'retired cache bytes', 'utf8');

      const result = await databaseAgent.runRaw(['doctor', '--json']);
      const report = JSON.parse(result.stdout) as DoctorReport;

      expect(findCheck(report, 'history-database').status).toBe('pass');
      expect(report.checks.some((check) => check.name === 'cache')).toBe(false);
      await expect(readFile(legacyCache, 'utf8')).resolves.toBe('retired cache bytes');
    } finally {
      await history.cleanup();
    }
  });

  it('classifies a corrupt registered database as retained history damage', async () => {
    const history = await databaseFixture();
    const databasePath = history.writer.databasePath;
    const backupPath = `${databasePath}.doctor-backup`;
    try {
      const databaseAgent = makeAgent({
        cwd: history.main,
        env: {
          CLAUDE_SESSION_ID: 'database-corruption',
          ORCAOPS_CLOUD_FEATURES: '0',
          ORCAOPS_DATA_DIR: history.root,
          ORCAOPS_DISABLE_DRAIN: '1',
        },
      });
      await databaseAgent.runRaw(['init', '--scope', 'project', '--no-llm']);
      await rename(databasePath, backupPath);
      await writeFile(databasePath, 'not a sqlite database', 'utf8');

      const result = await databaseAgent.runRaw(['doctor', '--json']);
      const report = JSON.parse(result.stdout) as DoctorReport;

      expect(result.exitCode).toBe(1);
      expect(findCheck(report, 'history-database').summary).toContain('HISTORY_INTEGRITY_REQUIRED');
    } finally {
      await rm(databasePath, { force: true });
      await rename(backupPath, databasePath);
      await history.cleanup();
    }
  });

  it('ignores a retired artifact projection root while retaining installer diagnostics', async () => {
    const history = await databaseFixture();
    const outside = await mkdtemp(path.join(tmpdir(), 'orcaops-retired-artifacts-'));
    try {
      const databaseAgent = makeAgent({
        cwd: history.main,
        env: {
          CLAUDE_SESSION_ID: 'database-projection-retirement',
          ORCAOPS_CLOUD_FEATURES: '0',
          ORCAOPS_DATA_DIR: history.root,
          ORCAOPS_DISABLE_DRAIN: '1',
        },
      });
      await databaseAgent.runRaw(['init', '--scope', 'project', '--no-llm']);
      const artifactsDir = path.join(history.main, '.orcaops', 'artifacts');
      await symlink(outside, artifactsDir);

      const result = await databaseAgent.runRaw(['doctor', '--json']);
      const report = JSON.parse(result.stdout) as DoctorReport;

      expect(findCheck(report, 'history-database').status).toBe('pass');
      expect(findCheck(report, 'evaluators').status).toBe('pass');
      expect(report.checks.some((check) => check.name === 'stale-projection')).toBe(false);
      expect(report.checks.some((check) => check.name === 'event-log-corruption')).toBe(false);
    } finally {
      await rm(path.join(history.main, '.orcaops', 'artifacts'), { force: true });
      await rm(outside, { recursive: true, force: true });
      await history.cleanup();
    }
  });

  it('watch-companion passes on the workspace build with no override', async () => {
    await agent.runRaw(['init', '--scope', 'project', '--no-llm']);
    const bare = makeAgent({
      cwd: repo.path,
      env: { CLAUDE_SESSION_ID: 'test-doctor', PATH: '/usr/bin:/bin' },
    });
    const r = JSON.parse((await bare.runRaw(['doctor', '--json'])).stdout) as DoctorReport;
    const check = findCheck(r, 'watch-companion');
    // The workspace CLI carries no platform pins, so resolution lands on the
    // dev tier (the @orcaops/watch app's build under Bun) and there is nothing
    // to fix.
    expect(check.status).toBe('pass');
    expect(check.summary).toMatch(/workspace build/);
    expect(check.details).toBeUndefined();
  });

  it('watch-companion reports an active override that exists', async () => {
    await agent.runRaw(['init', '--scope', 'project', '--no-llm']);
    const binDir = path.join(repo.path, '.fake-bin');
    await mkdir(binDir, { recursive: true });
    const watchBin = path.join(binDir, 'orcaops-watch-ui');
    await writeFile(watchBin, '#!/bin/sh\nexit 0\n', 'utf8');
    await chmod(watchBin, 0o755);

    const overridden = makeAgent({
      cwd: repo.path,
      env: { CLAUDE_SESSION_ID: 'test-doctor', ORCAOPS_WATCH_BIN: watchBin },
    });
    const r = JSON.parse((await overridden.runRaw(['doctor', '--json'])).stdout) as DoctorReport;
    const check = findCheck(r, 'watch-companion');
    expect(check.status).toBe('pass');
    expect(check.summary).toContain(watchBin);
    expect(check.summary).toMatch(/override active/);
  });

  it('watch-companion warns when ORCAOPS_WATCH_BIN points at nothing', async () => {
    await agent.runRaw(['init', '--scope', 'project', '--no-llm']);
    const missing = path.join(repo.path, 'no-such-orcaops-watch');
    const overridden = makeAgent({
      cwd: repo.path,
      env: { CLAUDE_SESSION_ID: 'test-doctor', ORCAOPS_WATCH_BIN: missing },
    });
    const r = JSON.parse((await overridden.runRaw(['doctor', '--json'])).stdout) as DoctorReport;
    const check = findCheck(r, 'watch-companion');
    expect(check.status).toBe('warn');
    expect(check.summary).toContain(missing);
  });

  it('llm-tool warns when config.llm.tool=claude but `claude` is not on PATH', async () => {
    // commandExists in @orcaops/llm spawns via execa() and receives the
    // per-call `env`, so an in-process makeAgent({ env }) can sanitize
    // PATH and observe the warn path without spawning the real binary.
    await agent.runRaw(['init', '--scope', 'project', '--no-llm']);
    const cfgPath = await effectiveConfigPath(repo.path);
    const cfg = JSON.parse(await readFile(cfgPath, 'utf8')) as { llm: { tool: string } };
    cfg.llm.tool = 'claude';
    await writeFile(cfgPath, JSON.stringify(cfg, null, 2) + '\n', 'utf8');

    const pathSanitized = makeAgent({
      cwd: repo.path,
      env: { CLAUDE_SESSION_ID: 'test-doctor', PATH: '/usr/bin:/bin' },
    });
    const res = await pathSanitized.runRaw(['doctor', '--json']);
    expect(res.exitCode).toBe(0);
    const r = JSON.parse(res.stdout) as DoctorReport;
    const check = findCheck(r, 'llm-tool');
    expect(check.status).toBe('warn');
    expect(check.summary).toMatch(/not on PATH/);
  });

  it('llm-tool probes the configured provider binary override', async () => {
    await agent.runRaw(['init', '--scope', 'project', '--no-llm']);
    const cfgPath = await effectiveConfigPath(repo.path);
    const cfg = JSON.parse(await readFile(cfgPath, 'utf8')) as { llm: { tool: string } };
    cfg.llm.tool = 'claude';
    await writeFile(cfgPath, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
    const calls = path.join(repo.path, 'provider-probe-calls');
    const providerBin = path.join(repo.path, 'configured-claude');
    await writeFile(providerBin, `#!/bin/sh\nprintf 'called\\n' >> '${calls}'\n`, 'utf8');
    await chmod(providerBin, 0o755);

    const overridden = makeAgent({
      cwd: repo.path,
      env: {
        CLAUDE_SESSION_ID: 'test-doctor-provider-override',
        ORCAOPS_CLAUDE_PATH: providerBin,
        ORCAOPS_CODEX_PATH: path.join(repo.path, 'missing-codex'),
        PATH: '/usr/bin:/bin',
      },
    });
    const res = await overridden.runRaw(['doctor', '--json']);
    expect(res.exitCode).toBe(0);
    const check = findCheck(JSON.parse(res.stdout) as DoctorReport, 'llm-tool');

    expect(check.status, JSON.stringify(check)).toBe('pass');
    expect(check.summary).toMatch(/claude found/);
    expect((await readFile(calls, 'utf8')).trim().split('\n')).toEqual(['called']);
  });

  it('llm-tool reports a probe it could not finish as unverified, not as a missing tool', async () => {
    // Telling a user to install a CLI they already have is a wrong remedy, so
    // a probe that never answered must not read as absence.
    await agent.runRaw(['init', '--scope', 'project', '--no-llm']);
    const cfgPath = await effectiveConfigPath(repo.path);
    const cfg = JSON.parse(await readFile(cfgPath, 'utf8')) as { llm: { tool: string } };
    cfg.llm.tool = 'claude';
    await writeFile(cfgPath, JSON.stringify(cfg, null, 2) + '\n', 'utf8');

    const binDir = await mkdtemp(path.join(tmpdir(), 'orcaops-llm-hang-'));
    const hanging = path.join(binDir, 'claude');
    await writeFile(hanging, '#!/bin/sh\n/bin/sleep 60\n', 'utf8');
    await chmod(hanging, 0o755);

    const slow = makeAgent({
      cwd: repo.path,
      env: { CLAUDE_SESSION_ID: 'test-doctor-slow-llm', PATH: binDir },
    });
    const res = await slow.runRaw(['doctor', '--json']);
    expect(res.exitCode).toBe(0);
    const check = findCheck(JSON.parse(res.stdout) as DoctorReport, 'llm-tool');

    expect(check.status, JSON.stringify(check)).toBe('pass');
    expect(check.summary).toMatch(/could not verify/);
    expect(check.summary).not.toMatch(/not on PATH/);
  }, 30_000);

  it('global-install: warns when this repo’s skills are recorded under another agent root', async () => {
    // A re-pointed config dir must read as its own diagnosis, not as the far
    // more confusing "nothing installed" — and must not fail the run.
    const globalRoot = await mkdtemp(path.join(tmpdir(), 'orcaops-doctor-global-'));
    const foreignRoot = await mkdtemp(path.join(tmpdir(), 'orcaops-doctor-foreign-'));
    try {
      const scoped = makeAgent({
        cwd: repo.path,
        env: {
          CLAUDE_SESSION_ID: 'test-doctor',
          ORCAOPS_CONFIG_HOME: path.join(repo.path, '.test-config-home'),
          ORCAOPS_GLOBAL_ROOT: globalRoot,
        },
      });
      await scoped.runRaw(['init', '--scope', 'global', '--no-llm']);

      const manifestPath = path.join(globalRoot, 'install.local.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
        entries: Array<{ path: string }>;
      };
      expect(manifest.entries.length).toBeGreaterThan(0);
      // The files must exist: the check reports STRANDED bytes, so an entry
      // whose file is already gone is deliberately silent.
      for (const e of manifest.entries) {
        e.path = path.join(foreignRoot, 'skills', path.basename(path.dirname(e.path)), 'SKILL.md');
        await mkdir(path.dirname(e.path), { recursive: true });
        await writeFile(e.path, 'stranded', 'utf8');
      }
      await writeFile(manifestPath, JSON.stringify(manifest), 'utf8');

      const res = await scoped.runRaw(['doctor', '--json']);
      const c = findCheck(JSON.parse(res.stdout) as DoctorReport, 'global-install');
      expect(c.status).toBe('warn');
      expect(c.summary).toMatch(/recorded under a different agent root/);
      expect(c.details?.join(' ')).toContain(foreignRoot);
      expect(c.details?.join(' ')).toMatch(/CLAUDE_CONFIG_DIR/);
    } finally {
      await rm(globalRoot, { recursive: true, force: true });
      await rm(foreignRoot, { recursive: true, force: true });
    }
  });

  it('global-install: still warns about stranded files when this root is materialized too', async () => {
    // The warning's own remedy is `orcaops update`. If a local install silenced
    // the notice, following that advice would hide the stranding permanently.
    const globalRoot = await mkdtemp(path.join(tmpdir(), 'orcaops-doctor-global3-'));
    const foreignRoot = await mkdtemp(path.join(tmpdir(), 'orcaops-doctor-foreign3-'));
    try {
      const scoped = makeAgent({
        cwd: repo.path,
        env: {
          CLAUDE_SESSION_ID: 'test-doctor',
          ORCAOPS_CONFIG_HOME: path.join(repo.path, '.test-config-home'),
          ORCAOPS_GLOBAL_ROOT: globalRoot,
        },
      });
      await scoped.runRaw(['init', '--scope', 'global', '--no-llm']);

      const manifestPath = path.join(globalRoot, 'install.local.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
        entries: Array<{ path: string; refs: string[]; surface: string }>;
      };
      const foreign = await Promise.all(
        manifest.entries.map(async (e) => {
          const p = path.join(
            foreignRoot,
            'skills',
            path.basename(path.dirname(e.path)),
            'SKILL.md'
          );
          await mkdir(path.dirname(p), { recursive: true });
          await writeFile(p, 'stranded', 'utf8');
          return { ...e, path: p };
        })
      );
      manifest.entries = [...manifest.entries, ...foreign];
      await writeFile(manifestPath, JSON.stringify(manifest), 'utf8');

      const res = await scoped.runRaw(['doctor', '--json']);
      const c = findCheck(JSON.parse(res.stdout) as DoctorReport, 'global-install');
      expect(c.status).toBe('warn');
      expect(c.summary).toMatch(/recorded under a different agent root/);
      expect(c.details?.join(' ')).toContain(foreignRoot);
      // Wording acknowledges orcaops does work here.
      expect(c.details?.join(' ')).toMatch(/own materialization/);
    } finally {
      await rm(globalRoot, { recursive: true, force: true });
      await rm(foreignRoot, { recursive: true, force: true });
    }
  });

  it('global-install: stays quiet when the other root’s files are already gone', async () => {
    // Entries whose files no longer exist leave nothing to act on, so they must
    // not warn — that is what keeps this from becoming permanent noise.
    const globalRoot = await mkdtemp(path.join(tmpdir(), 'orcaops-doctor-global2-'));
    const foreignRoot = await mkdtemp(path.join(tmpdir(), 'orcaops-doctor-foreign2-'));
    try {
      const scoped = makeAgent({
        cwd: repo.path,
        env: {
          CLAUDE_SESSION_ID: 'test-doctor',
          ORCAOPS_CONFIG_HOME: path.join(repo.path, '.test-config-home'),
          ORCAOPS_GLOBAL_ROOT: globalRoot,
        },
      });
      await scoped.runRaw(['init', '--scope', 'global', '--no-llm']);

      const manifestPath = path.join(globalRoot, 'install.local.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
        entries: Array<{ path: string; refs: string[] }>;
      };
      // Keep every live entry, and ADD a foreign-root copy of each carrying the
      // same refs — the shape left behind by installing under two config dirs.
      manifest.entries = [
        ...manifest.entries,
        ...manifest.entries.map((e) => ({
          ...e,
          path: path.join(foreignRoot, 'skills', path.basename(path.dirname(e.path)), 'SKILL.md'),
        })),
      ];
      await writeFile(manifestPath, JSON.stringify(manifest), 'utf8');

      const res = await scoped.runRaw(['doctor', '--json']);
      const c = findCheck(JSON.parse(res.stdout) as DoctorReport, 'global-install');
      expect(c.summary).not.toMatch(/recorded under a different agent root/);
      expect(c.status).not.toBe('fail');
    } finally {
      await rm(globalRoot, { recursive: true, force: true });
      await rm(foreignRoot, { recursive: true, force: true });
    }
  });

  it('retains installer diagnostics beside canonical database checks', async () => {
    const history = await databaseFixture();
    try {
      const databaseAgent = makeAgent({
        cwd: history.main,
        env: {
          CLAUDE_SESSION_ID: 'database-check-inventory',
          ORCAOPS_CLOUD_FEATURES: '0',
          ORCAOPS_DATA_DIR: history.root,
          ORCAOPS_DISABLE_DRAIN: '1',
        },
      });
      await databaseAgent.runRaw(['init', '--scope', 'project', '--no-llm']);

      const result = await databaseAgent.runRaw(['doctor', '--json']);
      const report = JSON.parse(result.stdout) as DoctorReport;
      const names = new Set(report.checks.map((check) => check.name));

      for (const name of [
        'agent-skills',
        'config',
        'evaluators',
        'git-hooks',
        'history-database',
        'artifact-integrity',
        'git-publications',
        'source-plan-history',
        'usage-history',
        'stale-pin',
        'watch-companion',
      ])
        expect(names.has(name), `missing ${name}`).toBe(true);
      for (const retired of [
        'archive-identity',
        'archive-index',
        'archive-manifest-derivation',
        'archive-mirror-lag',
        'archive-perms',
        'archive-redaction',
        'cache',
        'event-log-corruption',
        'review-cache-integrity',
        'stale-baseline-refs',
        'stale-projection',
        'stale-snapshot-refs',
      ])
        expect(names.has(retired), `retained retired check ${retired}`).toBe(false);
    } finally {
      await history.cleanup();
    }
  });

  it('skill-drift advises upgrade, not a no-op update, for an AHEAD disabled skill', async () => {
    await agent.runRaw(['init', '--scope', 'project', '--no-llm', '--agents-md']);
    // Disable a skill, leaving its installed dir behind, and restamp it as a
    // NEWER orcaops would have written it.
    const configPath = await effectiveConfigPath(repo.path);
    const config = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>;
    config.skills = { enabled: { why: false } };
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
    const skillPath = path.join(repo.path, '.claude', 'skills', 'orcaops-why', 'SKILL.md');
    const aheadBytes = (await readFile(skillPath, 'utf8')).replace(
      /orcaops@[^"\n]+/,
      'orcaops@99.0.0'
    );
    await writeFile(skillPath, aheadBytes, 'utf8');

    const first = JSON.parse((await agent.runRaw(['doctor', '--json'])).stdout) as DoctorReport;
    const drift = first.checks.find((c) => c.name === 'skill-drift');
    expect(drift?.status).toBe('warn');
    const details = (drift?.details ?? []).join('\n');
    expect(details).toMatch(/NEWER orcaops/);
    expect(details).not.toMatch(/Run `orcaops update` to prune/);

    // Plain update must not delete the ahead leftover, and doctor's advice
    // afterwards must not regress into the update loop.
    await agent.runRaw(['update', '--json']);
    expect(await readFile(skillPath, 'utf8')).toBe(aheadBytes);
    const second = JSON.parse((await agent.runRaw(['doctor', '--json'])).stdout) as DoctorReport;
    const driftAfter = second.checks.find((c) => c.name === 'skill-drift');
    expect((driftAfter?.details ?? []).join('\n')).toMatch(/NEWER orcaops/);
  });

  it('ignores a retired compose-session file', async () => {
    await agent.runRaw(['init', '--no-llm']);
    const reviewDir = path.join(repo.path, '.orcaops', 'reviews', 'demo');
    await mkdir(reviewDir, { recursive: true });
    await writeFile(path.join(reviewDir, 'compose-session-v1.json'), '{broken session');

    const res = await agent.runRaw(['doctor', '--json']);
    const report = JSON.parse(res.stdout) as DoctorReport;

    expect(res.exitCode).toBe(0);
    expect(report.checks.some((check) => check.name === 'review-compose-identity')).toBe(false);
    expect(report.checks.every((check) => check.status !== 'fail')).toBe(true);
  });

  it('agents-md passes when init wrote the bootstrap section to AGENTS.md + CLAUDE.md', async () => {
    await agent.runRaw(['init', '--scope', 'project', '--no-llm', '--agents-md']);
    const res = await agent.runRaw(['doctor', '--json']);
    const r = JSON.parse(res.stdout) as DoctorReport;
    const check = findCheck(r, 'agents-md');
    expect(check.status).toBe('pass');
    expect(check.summary).toMatch(/AGENTS\.md \+ CLAUDE\.md/);
  });

  it('agents-md passes (suppressed) when init ran --no-agents-md → bootstrap=manual', async () => {
    // --no-agents-md persists as bootstrap=manual (a desired state),
    // so doctor stops warning about the missing block — the user owns it.
    await agent.runRaw(['init', '--scope', 'project', '--no-llm', '--no-agents-md']);
    const res = await agent.runRaw(['doctor', '--json']);
    expect(res.exitCode).toBe(0);
    const r = JSON.parse(res.stdout) as DoctorReport;
    const check = findCheck(r, 'agents-md');
    expect(check.status).toBe('pass');
    expect(check.summary).toMatch(/bootstrap=manual/);
  });

  it('agents-md warns when the version stamp in the marker is stale', async () => {
    await agent.runRaw(['init', '--scope', 'project', '--no-llm', '--agents-md']);
    const agentsMdPath = path.join(repo.path, 'AGENTS.md');
    const original = await readFile(agentsMdPath, 'utf8');
    await writeFile(
      agentsMdPath,
      original.replace(/orcaops:start v=[^\s]+/, 'orcaops:start v=0.0.0-stale-agentsmd'),
      'utf8'
    );

    const res = await agent.runRaw(['doctor', '--json']);
    const r = JSON.parse(res.stdout) as DoctorReport;
    const check = findCheck(r, 'agents-md');
    expect(check.status).toBe('warn');
    // CLAUDE.md symlinks to the canonical AGENTS.md, so staling AGENTS.md
    // makes both instruction-file paths read the stale stamp (2 stale).
    expect(check.summary).toMatch(/2 stale/);
    expect(check.details?.some((d) => d.includes('0.0.0-stale-agentsmd'))).toBe(true);
  });

  it('agents-md passes when the install set is empty (no bootstrap surface managed)', async () => {
    await agent.runRaw(['init', '--scope', 'project', '--agents', '', '--no-llm']);

    const res = await agent.runRaw(['doctor', '--json']);
    const r = JSON.parse(res.stdout) as DoctorReport;
    const check = findCheck(r, 'agents-md');
    expect(check.status).toBe('pass');
    expect(check.summary).toMatch(/no install agents/);
  });

  it('block-skill-refs passes when the managed block matches the configured prefix', async () => {
    await agent.runRaw(['init', '--scope', 'project', '--no-llm', '--prefix', 'oo', '--agents-md']);
    const res = await agent.runRaw(['doctor', '--json']);
    const r = JSON.parse(res.stdout) as DoctorReport;
    const check = findCheck(r, 'block-skill-refs');
    expect(check.status).toBe('pass');
    expect(check.summary).toMatch(/oo-\*/);
  });

  it('block-skill-refs warns when the prefix changed without an update (drift)', async () => {
    await agent.runRaw(['init', '--scope', 'project', '--no-llm', '--agents-md']); // block references orcaops-* skills
    // Flip the configured prefix WITHOUT re-running update — the block is now stale.
    const cfgPath = await effectiveConfigPath(repo.path);
    const cfg = JSON.parse(await readFile(cfgPath, 'utf8')) as { naming?: { prefix: string } };
    // Init writes a minimal delta — default-valued subtrees are absent.
    cfg.naming = { ...(cfg.naming ?? {}), prefix: 'oo' };
    await writeFile(cfgPath, JSON.stringify(cfg, null, 2) + '\n', 'utf8');

    const res = await agent.runRaw(['doctor', '--json']);
    const r = JSON.parse(res.stdout) as DoctorReport;
    const check = findCheck(r, 'block-skill-refs');
    expect(check.status).toBe('warn');
    expect(check.summary).toMatch(/oo/);
  });

  it('block-skill-refs warns on a dead ref to a NON-lifecycle skill', async () => {
    // Pins the LINGERING direction: the block renders read-intent routing for
    // enabled skills, so disabling one WITHOUT re-rendering leaves a dead ref
    // pointing the agent at a skill it cannot invoke — that must warn.
    await agent.runRaw(['init', '--scope', 'project', '--no-llm', '--agents-md']);

    const agentsMdPath = path.join(repo.path, 'AGENTS.md');
    expect(await readFile(agentsMdPath, 'utf8')).toContain('orcaops-resume');

    const cfgPath = await effectiveConfigPath(repo.path);
    const cfg = JSON.parse(await readFile(cfgPath, 'utf8')) as {
      skills?: { enabled: Record<string, boolean> };
    };
    cfg.skills = { enabled: { resume: false } };
    await writeFile(cfgPath, JSON.stringify(cfg, null, 2) + '\n', 'utf8');

    const res = await agent.runRaw(['doctor', '--json']);
    const r = JSON.parse(res.stdout) as DoctorReport;
    const check = findCheck(r, 'block-skill-refs');
    expect(check.status).toBe('warn');
    expect(check.summary).toMatch(/disabled skill/);
    expect(check.details?.join('\n')).toMatch(/orcaops-resume/);
  });

  // ── lineage-orphan check ───────────────────────────────────────────
  describe('evaluator-health doctor checks', () => {
    it('fingerprint-zero-match warns when a pack ships a fingerprint.include pattern matching no files', async () => {
      await agent.runRaw(['init', '--scope', 'project', '--no-llm']);
      // Build a temp pack whose only spec has a fingerprint.include
      // pattern that resolves to zero matches. discoverEvaluators
      // succeeds; checkFingerprintZeroMatch surfaces the warn.
      const tmpParent = await mkdtemp(path.join(tmpdir(), 'orcaops-fp-zero-'));
      const packDir = path.join(tmpParent, 'fp-zero-pack');
      const { mkdir: mk } = await import('node:fs/promises');
      await mk(path.join(packDir, 'evaluators'), { recursive: true });
      await mk(path.join(packDir, 'runtime'), { recursive: true });
      await writeFile(
        path.join(packDir, 'package.yaml'),
        [
          'schema: orcaops.evaluator_package/v1',
          'id: fp-zero',
          'name: fp-zero',
          'version: 0.0.1',
          'description: fixture',
          'evaluator_dir: ./evaluators',
          'defaults:',
          '  timeout_ms: 30000',
        ].join('\n'),
        'utf8'
      );
      await writeFile(
        path.join(packDir, 'runtime', 'stub.mjs'),
        `process.stdout.write(JSON.stringify({ schema: 'orcaops.evaluator_result/v1', verdict: 'pass', body: 'PASS' }));\n`,
        'utf8'
      );
      await writeFile(
        path.join(packDir, 'evaluators', 'fp-zero.eval.yaml'),
        [
          'schema: orcaops.evaluator/v1',
          'id: fp-zero',
          'phase: post-plan',
          'severity: info',
          'description: zero-match include',
          'engine:',
          '  kind: command',
          '  command:',
          '    - node',
          '    - ./runtime/stub.mjs',
          'fingerprint:',
          '  include:',
          "    - 'nothing/**/*.tsx'",
        ].join('\n'),
        'utf8'
      );
      const addRes = await agent.runRaw(['eval', 'add-pack', packDir, '--yes', '--json']);
      expect(addRes.exitCode).toBe(0);

      try {
        const res = await agent.runRaw(['doctor', '--json']);
        const r = JSON.parse(res.stdout) as DoctorReport;
        const check = findCheck(r, 'fingerprint-zero-match');
        expect(check.status).toBe('warn');
        expect(check.details?.some((d) => d.includes('fp-zero/fp-zero'))).toBe(true);
      } finally {
        await rm(tmpParent, { recursive: true, force: true });
      }
    });

    it('command-evaluator-trust covers file-reading LLM packs: PASS when granted, no_trust when the grant is stripped', async () => {
      // doctor's checkCommandEvaluatorTrust must surface
      // file_reading_llm_evaluator_present packs, not just command ones. An
      // command-filtered llm-engine evaluator can read files
      // and ships it to the API, so it requires the same explicit trust grant.
      await agent.runRaw(['init', '--scope', 'project', '--no-llm']);
      const tmpParent = await mkdtemp(path.join(tmpdir(), 'orcaops-fr-trust-'));
      const packDir = path.join(tmpParent, 'fr-pack');
      const { mkdir: mk } = await import('node:fs/promises');
      await mk(path.join(packDir, 'evaluators'), { recursive: true });
      await mk(path.join(packDir, 'prompts'), { recursive: true });
      await writeFile(
        path.join(packDir, 'package.yaml'),
        [
          'schema: orcaops.evaluator_package/v1',
          'id: fr-pack',
          'name: fr-pack',
          'version: 0.0.1',
          'description: file-reading fixture',
          'evaluator_dir: ./evaluators',
          'defaults:',
          '  timeout_ms: 30000',
        ].join('\n'),
        'utf8'
      );
      await writeFile(
        path.join(packDir, 'evaluators', 'file-reader.eval.yaml'),
        [
          'schema: orcaops.evaluator/v1',
          'id: file-reader',
          'phase: pre-pr',
          'severity: warn',
          'description: reads worktree files to grade delivery',
          'engine:',
          '  kind: llm',
          '  additional_context_sections: []',
          '  prompt_file: prompts/file-reader.prompt.md',
          '  output_format: markdown',
          '  tool_policy:',
          '    mode: command-filtered',
          'filters:',
          '  when_llm: required',
        ].join('\n'),
        'utf8'
      );
      await writeFile(
        path.join(packDir, 'prompts', 'file-reader.prompt.md'),
        'Grade delivery by reading the diff.\n',
        'utf8'
      );
      try {
        // add-pack --yes grants file-reading trust non-interactively. The
        // all profile ENABLES the evaluator: doctor reports exactly where
        // dispatch refuses, and a disabled evaluator never dispatches.
        const addRes = await agent.runRaw([
          'eval',
          'add-pack',
          packDir,
          '--profile',
          'all',
          '--yes',
          '--json',
        ]);
        expect(addRes.exitCode).toBe(0);

        // Granted → doctor's trust check passes for the file-reading pack.
        const pass = await agent.runRaw(['doctor', '--json']);
        const passReport = JSON.parse(pass.stdout) as DoctorReport;
        expect(findCheck(passReport, 'command-evaluator-trust').status).toBe('pass');

        // Revoke the USER-LOCAL grant → the file-reading pack is untrusted;
        // doctor must flag it (no_trust), proving the check is NOT limited to
        // command evaluators. (Trust no longer lives in the repo yaml at all.)
        const revoke = await agent.runRaw(['eval', 'trust', 'fr-pack', '--revoke', '--json']);
        expect(revoke.exitCode).toBe(0);

        const warn = await agent.runRaw(['doctor', '--json']);
        const warnReport = JSON.parse(warn.stdout) as DoctorReport;
        const check = findCheck(warnReport, 'command-evaluator-trust');
        expect(check.status).toBe('warn');
        expect(check.details?.some((d) => d.includes('fr-pack') && d.includes('no_trust'))).toBe(
          true
        );
      } finally {
        await rm(tmpParent, { recursive: true, force: true });
      }
    });

    it('command-evaluator-trust warns with fingerprint_mismatch when pack runtime mutates after install', async () => {
      // update-pack-trust.test.ts covers the runUpdatePack
      // path; this test verifies doctor's checkCommandEvaluatorTrust
      // surfaces the same drift via its async path (validatePack +
      // computePackSourceFingerprint).
      await agent.runRaw(['init', '--scope', 'project', '--no-llm']);
      const tmpParent = await mkdtemp(path.join(tmpdir(), 'orcaops-trust-doctor-'));
      const { cp } = await import('node:fs/promises');
      const packDir = path.join(tmpParent, 'test-pack');
      await cp(TEST_PACK_ABS_PATH, packDir, { recursive: true });
      try {
        const addRes = await agent.runRaw(['eval', 'add-pack', packDir, '--yes', '--json']);
        expect(addRes.exitCode).toBe(0);
        // Mutate runtime bytes; doctor recomputes fingerprint and
        // surfaces the mismatch.
        const runtimeFile = path.join(packDir, 'runtime', 'api-stub.mjs');
        const original = await readFile(runtimeFile, 'utf8');
        await writeFile(runtimeFile, original + '\n// mutated\n', 'utf8');

        const res = await agent.runRaw(['doctor', '--json']);
        const r = JSON.parse(res.stdout) as DoctorReport;
        const check = findCheck(r, 'command-evaluator-trust');
        expect(check.status).toBe('warn');
        // Doctor now reports the SHARED trust decision's reason rather than its
        // own offender taxonomy; the changed-since-granted case stays
        // distinguishable from never-granted by its message.
        expect(check.details?.some((d) => d.includes('changed since it was granted'))).toBe(true);
      } finally {
        await rm(tmpParent, { recursive: true, force: true });
      }
    });

    it('reports trust and availability for an ungranted Codex override', async () => {
      await agent.runRaw(['init', '--scope', 'project', '--no-llm']);
      const configFile = await effectiveConfigPath(repo.path);
      const cfg = JSON.parse(await readFile(configFile, 'utf8')) as {
        llm?: Record<string, unknown>;
      };
      cfg.llm = { ...(cfg.llm ?? {}), tool: 'codex' };
      await writeFile(configFile, JSON.stringify(cfg, null, 2) + '\n', 'utf8');

      const tmpParent = await mkdtemp(path.join(tmpdir(), 'orcaops-trust-doctor-'));
      try {
        // Repo config can select a provider but cannot grant its capabilities.
        const packDir = path.join(tmpParent, 'implicit-doctor-pack');
        await mkdir(path.join(packDir, 'evaluators'), { recursive: true });
        await mkdir(path.join(packDir, 'prompts'), { recursive: true });
        await writeFile(
          path.join(packDir, 'package.yaml'),
          [
            'schema: orcaops.evaluator_package/v1',
            'id: implicit-doctor-pack',
            'name: implicit-doctor-pack',
            'version: 0.0.1',
            'description: implicit-provider llm pack',
            'evaluator_dir: ./evaluators',
          ].join('\n'),
          'utf8'
        );
        await writeFile(path.join(packDir, 'prompts', 'plain.md'), 'Decide.\n', 'utf8');
        await writeFile(
          path.join(packDir, 'evaluators', 'plain.eval.yaml'),
          [
            'schema: orcaops.evaluator/v1',
            'id: plain',
            'phase: post-plan',
            'severity: warn',
            'description: declares neither provider nor tool_policy',
            'engine:',
            '  kind: llm',
            '  additional_context_sections: []',
            '  prompt_file: ./prompts/plain.md',
            '  output_format: markdown',
            '  timeout_ms: 120000',
            'filters:',
            '  when_llm: required',
          ].join('\n'),
          'utf8'
        );
        await writeFile(
          path.join(packDir, 'evaluators', 'cleared.eval.yaml'),
          [
            'schema: orcaops.evaluator/v1',
            'id: cleared',
            'phase: post-plan',
            'severity: warn',
            'description: clears a pack provider pin',
            'engine:',
            '  kind: llm',
            '  additional_context_sections: []',
            '  prompt_file: ./prompts/plain.md',
            '  output_format: markdown',
            '  provider: claude',
            '  timeout_ms: 120000',
            'filters:',
            '  when_llm: required',
          ].join('\n'),
          'utf8'
        );
        await writeFile(
          path.join(repo.path, '.orcaops', 'evaluators.yaml'),
          'schema: orcaops.evaluator_config/v2\n' +
            'packages:\n' +
            '  - id: implicit-doctor-pack\n' +
            '    source:\n' +
            '      kind: path\n' +
            `      path: ${packDir}\n` +
            'evaluators:\n' +
            '  implicit-doctor-pack/plain:\n' +
            '    enabled: true\n' +
            '    engine:\n' +
            '      provider: codex\n' +
            '  implicit-doctor-pack/cleared:\n' +
            '    enabled: true\n' +
            '    engine:\n' +
            '      provider: null\n',
          'utf8'
        );

        const providerMissingAgent = makeAgent({
          cwd: repo.path,
          env: {
            CLAUDE_SESSION_ID: 'test-doctor',
            ORCAOPS_CODEX_PATH: path.join(tmpParent, 'missing-codex'),
          },
        });
        const res = await providerMissingAgent.runRaw(['doctor', '--json']);
        const r = JSON.parse(res.stdout) as DoctorReport;
        const trustCheck = findCheck(r, 'command-evaluator-trust');
        expect(trustCheck.status).toBe('warn');
        expect(
          trustCheck.details?.some(
            (d) => d.includes('implicit-doctor-pack') && d.includes('no_trust')
          )
        ).toBe(true);
        const availabilityCheck = findCheck(r, 'evaluator-provider-availability');
        expect(availabilityCheck.status).toBe('warn');
        expect(
          availabilityCheck.details?.some(
            (d) =>
              d.includes('implicit-doctor-pack/plain') &&
              d.includes('resolved provider codex is not installed') &&
              d.includes('selected by your .orcaops/evaluators.yaml override')
          )
        ).toBe(true);
        expect(
          availabilityCheck.details?.some(
            (d) =>
              d.includes('implicit-doctor-pack/cleared') &&
              d.includes('resolved provider codex is not installed') &&
              d.includes('provider pin cleared by your .orcaops/evaluators.yaml override') &&
              d.includes('selected from global llm.tool')
          )
        ).toBe(true);
      } finally {
        await rm(tmpParent, { recursive: true, force: true });
      }
    });

    it('command-evaluator-trust warns for a capability-short grant dispatch would refuse', async () => {
      await agent.runRaw(['init', '--no-llm']);
      const tmpParent = await mkdtemp(path.join(tmpdir(), 'orcaops-trust-doctor-'));
      const { cp } = await import('node:fs/promises');
      const packDir = path.join(tmpParent, 'short-grant-pack');
      await cp(TEST_PACK_ABS_PATH, packDir, { recursive: true });
      try {
        // Extend the command test-pack with an implicit llm evaluator, and
        // rename the pack so its grant cannot collide with other tests.
        const manifest = await readFile(path.join(packDir, 'package.yaml'), 'utf8');
        await writeFile(
          path.join(packDir, 'package.yaml'),
          manifest
            .replace(/^id: .*$/m, 'id: short-grant-pack')
            .replace(/^name: .*$/m, 'name: short-grant-pack'),
          'utf8'
        );
        await mkdir(path.join(packDir, 'prompts'), { recursive: true });
        await writeFile(path.join(packDir, 'prompts', 'plain.md'), 'Decide.\n', 'utf8');
        await writeFile(
          path.join(packDir, 'evaluators', 'plain-llm.eval.yaml'),
          [
            'schema: orcaops.evaluator/v1',
            'id: plain-llm',
            'phase: post-plan',
            'severity: warn',
            'description: declares neither provider nor tool_policy',
            'engine:',
            '  kind: llm',
            '  additional_context_sections: []',
            '  prompt_file: ./prompts/plain.md',
            '  output_format: markdown',
            '  timeout_ms: 120000',
            'filters:',
            '  when_llm: required',
          ].join('\n'),
          'utf8'
        );

        // Grant under tool 'none': the implicit evaluator classifies as
        // ungated, so the recorded grant carries only the command capability.
        // The 'all' profile enables both evaluators so dispatch would
        // actually gate the llm one.
        const addRes = await agent.runRaw([
          'eval',
          'add-pack',
          packDir,
          '--profile',
          'all',
          '--yes',
          '--json',
        ]);
        expect(addRes.exitCode).toBe(0);

        // Switch the default to codex: dispatch now requires file-reading for
        // the implicit evaluator, which the grant does not carry. A
        // verdict-only doctor read reported this trusted; the full gate warns.
        const configFile = await effectiveConfigPath(repo.path);
        const cfg = JSON.parse(await readFile(configFile, 'utf8')) as {
          llm?: Record<string, unknown>;
        };
        cfg.llm = { ...(cfg.llm ?? {}), tool: 'codex' };
        await writeFile(configFile, JSON.stringify(cfg, null, 2) + '\n', 'utf8');

        const res = await agent.runRaw(['doctor', '--json']);
        const r = JSON.parse(res.stdout) as DoctorReport;
        const check = findCheck(r, 'command-evaluator-trust');
        expect(check.status).toBe('warn');
        expect(
          check.details?.some(
            (d) =>
              d.includes('short-grant-pack') &&
              d.includes('granted without') &&
              d.includes('file_reading_llm_evaluator_present')
          )
        ).toBe(true);
      } finally {
        await agent.runRaw(['eval', 'trust', 'short-grant-pack', '--revoke', '--json']);
        await rm(tmpParent, { recursive: true, force: true });
      }
    });
  });
});

describe('orcaops doctor — canonical history checks', () => {
  let history: Awaited<ReturnType<typeof databaseFixture>>;
  let databaseAgent: ReturnType<typeof makeAgent>;

  beforeEach(async () => {
    history = await databaseFixture();
    databaseAgent = makeAgent({
      cwd: history.main,
      env: {
        CLAUDE_SESSION_ID: 'test-doctor-history',
        ORCAOPS_CLOUD_FEATURES: '0',
        ORCAOPS_DATA_DIR: history.root,
        ORCAOPS_DISABLE_DRAIN: '1',
      },
    });
    await databaseAgent.runRaw(['init', '--scope', 'project', '--no-llm']);
  });

  afterEach(async () => {
    await history.cleanup();
  });

  it('reports no managed publications when registered history has none', async () => {
    const result = await databaseAgent.runRaw(['doctor', '--json']);
    const report = JSON.parse(result.stdout) as DoctorReport;

    expect(findCheck(report, 'git-publications')).toMatchObject({
      status: 'pass',
      summary: expect.stringContaining('0 publication ref(s)'),
    });
    expect(report.checks.some((check) => check.name === 'stale-snapshot-refs')).toBe(false);
    expect(report.checks.some((check) => check.name === 'stale-baseline-refs')).toBe(false);
  });

  it('reports an unowned managed ref with its observed OID and preserves it', async () => {
    const artifactId = '019e0000-0000-7000-8000-000000000000';
    const publicationId = '019e0000-0000-7000-8000-000000000001';
    const fullRef = `refs/orcaops/snap/${artifactId}/1/open-${publicationId}`;
    const oid = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: history.main }).toString().trim();
    execFileSync('git', ['update-ref', fullRef, oid], { cwd: history.main });

    const result = await databaseAgent.runRaw(['doctor', '--json']);
    const publication = findCheck(JSON.parse(result.stdout) as DoctorReport, 'git-publications');

    expect(publication.status).toBe('warn');
    expect(publication.details?.join('\n')).toContain(fullRef);
    expect(publication.details?.join('\n')).toContain(oid);
    expect(publication.details?.join('\n')).toContain('protected/unknown');
    expect(publication.details?.join('\n')).toContain('publication=unowned');
    expect(
      execFileSync('git', ['rev-parse', fullRef], { cwd: history.main }).toString().trim()
    ).toBe(oid);
  });

  it('reports retained skipped fingerprint evidence without consulting file projections', async () => {
    const artifactId = await history.capture();
    await history.recordFiles(artifactId, ['src/example.ts']);

    const result = await databaseAgent.runRaw(['doctor', '--json']);
    const fingerprint = findCheck(
      JSON.parse(result.stdout) as DoctorReport,
      'skipped-fingerprint-rate'
    );

    expect(fingerprint.status).toBe('warn');
    expect(fingerprint.details?.join('\n')).toContain(artifactId);
  });
});
