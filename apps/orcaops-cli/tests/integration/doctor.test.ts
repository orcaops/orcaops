import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  artifactPathsFor,
  getDefaultConfig,
  type ReviewPullRecord,
  sha256Hex,
  sourcePlanCacheDir,
  writeReviewPullRecord,
} from '@orcaops/storage';
import {
  createRepoTemplate,
  createTempRepo,
  inputFile,
  type TempRepo,
} from '@orcaops/test-harness';

import { sanitizeDoctorChecks } from '../../src/commands/doctor.js';
import { makeAgent } from '../support/test-agent.js';
import {
  commitFile,
  effectiveConfigPath,
  installTestPack,
  plantAcknowledge,
  plantBlockViolation,
  TEST_PACK_ABS_PATH,
} from '../support/test-helpers.js';

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

/** A valid review-pull candidate record for seeding the review cache. */
function reviewCandidate(body: string): ReviewPullRecord {
  return {
    schema_version: 1,
    target: 'candidate',
    external_id: 'ext-review-1',
    version_id: 'ver_1',
    version_number: 1,
    proposal_id: null,
    base_version_number: null,
    content_hash: sha256Hex(body),
    body,
    base_url: 'https://cloud.example',
    org_id: 'org_1',
    pulled_at: '2026-06-10T00:00:00.000Z',
  };
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
    expect(res.exitCode).toBe(0);
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

  it('surfaces protected artifact-deletion recovery state', async () => {
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
    const recovery = findCheck(report, 'artifact-deletion-recovery');
    expect(recovery.status).toBe('warn');
    expect(recovery.summary).toContain('1 protected artifact deletion');
    expect(recovery.details?.join('\n')).toContain(artifactId);
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

  it('human output summarizes healthy sections and discloses the seed warning', async () => {
    await agent.runRaw(['init', '--scope', 'project', '--no-llm', '--agents-md']);
    const res = await agent.runRaw(['doctor']);
    expect(res.exitCode).toBe(0);
    // The version is normalized like the repo path above: pinning it would
    // fail this snapshot on every release without telling anyone anything
    // about doctor's output.
    expect(
      res.stdout
        .replace(/^ {2}repo: .*$/m, '  repo: <repo>')
        .replace(/^orcaops doctor — v.*$/m, 'orcaops doctor — <version>')
    ).toMatchInlineSnapshot(`
      "orcaops doctor — <version>
        repo: <repo>

      ✓ repository           8 checks passed
      ✓ install surfaces     9 checks passed
      ✓ artifact state       22/23 checks passed
        archive-redaction: archive mirror stores event text verbatim (archive.redact_secrets: false)
          The mirror is outside the repository and outside .gitignore, and survives deleting the worktree. Set archive.redact_secrets: true to redact the copy — a cold-start \`orcaops resume\` then restores the redacted text.
      ⚠ seed                 git history exists but Orcaops has never been seeded
        Preview with \`orcaops seed --dry-run\`; apply with \`orcaops seed --yes\` or \`orcaops doctor --fix\`.
      ✓ evaluator health     9 checks passed
      ✓ pins and shell       6 checks passed

      Overall: WARN (1 warning(s))
      "
    `);
    expect(res.stdout).not.toMatch(/✓ git-repo/);
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

  it('cache check reports schema version + row counts after a captured artifact', async () => {
    await agent.runRaw(['init', '--scope', 'project', '--json', '--no-llm']);
    const plan = await agent.runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--input',
      inputFile(
        JSON.stringify({
          task: 'tiny task',
          label: 'lbl',
          plan_steps: [{ text: 'step a', label: 's1' }],
          touched_scope: [],
        })
      ),
    ]);
    expect(plan.exitCode).toBe(0);

    const res = await agent.runRaw(['doctor', '--json']);
    expect(res.exitCode).toBe(0);
    const r = JSON.parse(res.stdout) as DoctorReport;
    const cache = findCheck(r, 'cache');
    expect(cache.status).toBe('pass');
    // schema v25 — the current whole-schema baseline.
    expect(cache.summary).toMatch(/schema v25/);
    expect(cache.summary).toMatch(/1 artifact/);
  });

  it('cache check fails when SQLite cache is corrupt (open throws)', async () => {
    await agent.runRaw(['init', '--scope', 'project', '--no-llm']);
    // Overwrite the DB file with junk so better-sqlite3's open will reject it.
    const dbPath = path.join(repo.path, '.orcaops', 'cache', 'orcaops.db');
    await mkdir(path.dirname(dbPath), { recursive: true });
    await writeFile(dbPath, 'definitely not a sqlite file', 'utf8');

    const res = await agent.runRaw(['doctor', '--json']);
    expect(res.exitCode).toBe(1);
    const r = JSON.parse(res.stdout) as DoctorReport;
    expect(r.overall).toBe('fail');
    const cache = findCheck(r, 'cache');
    expect(cache.status).toBe('fail');
    expect(cache.details?.some((d) => d.includes('orcaops rebuild'))).toBe(true);
  });

  it('reports a poisoned artifacts root without replacing the doctor report', async () => {
    await agent.runRaw(['init', '--no-llm']);
    const plan = await agent.runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--input',
      inputFile(
        JSON.stringify({
          task: 'poisoned root fixture',
          label: 'poisoned root fixture',
          plan_steps: [{ text: 'close one checkpoint', label: 'close one checkpoint' }],
          touched_scope: [],
        })
      ),
    ]);
    expect(plan.exitCode).toBe(0);
    const captured = JSON.parse(plan.stdout) as {
      artifact_id: string;
      plan_steps: Array<{ step_id: string }>;
    };
    const opened = await agent.runRaw([
      'capture',
      'checkpoint',
      'open',
      '--no-llm',
      '--input',
      inputFile(
        JSON.stringify({
          artifact_id: captured.artifact_id,
          declared_step_ids: [captured.plan_steps[0].step_id],
        })
      ),
    ]);
    expect(opened.exitCode).toBe(0);
    const closed = await agent.runRaw([
      'capture',
      'checkpoint',
      'close',
      '--no-llm',
      '--input',
      inputFile(
        JSON.stringify({
          artifact_id: captured.artifact_id,
          n: 1,
          summary: 'closed checkpoint',
          files_changed: [],
        })
      ),
    ]);
    expect(closed.exitCode).toBe(0);

    const outside = await mkdtemp(path.join(tmpdir(), 'orcaops-poisoned-artifacts-'));
    const artifactsDir = path.join(repo.path, '.orcaops', 'artifacts');
    try {
      await rm(artifactsDir, { recursive: true });
      await symlink(outside, artifactsDir);

      const res = await agent.runRaw(['doctor', '--json']);
      const report = JSON.parse(res.stdout) as DoctorReport;
      expect(report.ok).toBe(true);
      expect(report.overall).toBe('fail');
      expect(findCheck(report, 'cache').status).toBe('fail');
      expect(findCheck(report, 'evaluators').status).toBe('pass');
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('event-log-corruption fails and names the artifact and line with the archive disabled', async () => {
    await agent.runRaw(['init', '--json', '--no-llm']);
    const plan = await agent.runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--input',
      inputFile(
        JSON.stringify({
          task: 'tiny task',
          label: 'lbl',
          plan_steps: [{ text: 'step a', label: 's1' }],
          touched_scope: [],
        })
      ),
    ]);
    expect(plan.exitCode).toBe(0);
    const artifactId = (JSON.parse(plan.stdout) as { artifact_id: string }).artifact_id;

    // Rot the plan_captured line the way disk corruption does: valid JSON,
    // valid schema, wrong checksum.
    const logPath = path.join(repo.path, '.orcaops', 'artifacts', artifactId, 'events.ndjson');
    const raw = await readFile(logPath, 'utf8');
    await writeFile(
      logPath,
      raw.replace(/"checksum":"[0-9a-f]{64}"/, `"checksum":"${'0'.repeat(64)}"`),
      'utf8'
    );

    const res = await agent.runRaw(['doctor', '--json']);
    expect(res.exitCode).toBe(1);
    const r = JSON.parse(res.stdout) as DoctorReport;
    const check = findCheck(r, 'event-log-corruption');
    expect(check.status).toBe('fail');
    expect(check.details?.some((d) => d.includes(artifactId) && d.includes('line 1'))).toBe(true);
  });

  it('event-log-corruption covers an artifact directory with no SQLite row', async () => {
    await agent.runRaw(['init', '--json', '--no-llm']);
    // A directory rebuild skipped: no capture ever registered it in the
    // cache, but its on-disk log carries a lost line.
    const orphanId = '019faaaa-0000-7000-8000-000000000abc';
    const dir = path.join(repo.path, '.orcaops', 'artifacts', orphanId);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'events.ndjson'), '{"garbage\n', 'utf8');

    const res = await agent.runRaw(['doctor', '--json']);
    expect(res.exitCode).toBe(1);
    const r = JSON.parse(res.stdout) as DoctorReport;
    const check = findCheck(r, 'event-log-corruption');
    expect(check.status).toBe('fail');
    expect(check.details?.some((d) => d.includes(orphanId) && d.includes('line 1'))).toBe(true);
  });

  it('a crash-tail-only report FAILS — captures refuse, so green would be a lie', async () => {
    await agent.runRaw(['init', '--json', '--no-llm']);
    const tailId = '019feeee-0000-7000-8000-000000000abc';
    await mkdir(path.join(repo.path, '.orcaops', 'artifacts', tailId), { recursive: true });
    await writeFile(
      path.join(repo.path, '.orcaops', 'artifacts', tailId, 'events.ndjson'),
      '{"partial',
      'utf8'
    );

    const res = await agent.runRaw(['doctor', '--json']);
    expect(res.exitCode).toBe(1);
    const r = JSON.parse(res.stdout) as DoctorReport;
    const check = findCheck(r, 'event-log-corruption');
    expect(check.status).toBe('fail');
    expect(check.summary).toMatch(/crash-truncated tail/);
  });

  it('counts a genuinely unrecoverable artifact as unreadable-skipped in the pin check', async () => {
    await agent.runRaw(['init', '--json', '--no-llm']);
    const plan = await agent.runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--input',
      inputFile(
        JSON.stringify({
          task: 'to be broken',
          label: 'broken',
          plan_steps: [{ text: 'a', label: 'a' }],
          touched_scope: [],
        })
      ),
    ]);
    const artifactId = (JSON.parse(plan.stdout) as { artifact_id: string }).artifact_id;
    // Garble artifact.json AND delete the log: recovery has nothing to
    // rebuild from, so readArtifact refuses — the pin check must count
    // it as unreadable-skipped rather than vanish or crash.
    const dir = path.join(repo.path, '.orcaops', 'artifacts', artifactId);
    await writeFile(path.join(dir, 'artifact.json'), '{garbled', 'utf8');
    await rm(path.join(dir, 'events.ndjson'));

    const res = await agent.runRaw(['doctor', '--json']);
    const r = JSON.parse(res.stdout) as DoctorReport;
    const c = findCheck(r, 'source-plan-pin-integrity');
    expect(c.summary).toMatch(/unreadable, skipped/);
  });

  it("crash-tail warnings stay visible beside another artifact's lost lines", async () => {
    await agent.runRaw(['init', '--json', '--no-llm']);
    const lostId = '019fcccc-0000-7000-8000-000000000abc';
    const tailId = '019fdddd-0000-7000-8000-000000000abc';
    await mkdir(path.join(repo.path, '.orcaops', 'artifacts', lostId), { recursive: true });
    await writeFile(
      path.join(repo.path, '.orcaops', 'artifacts', lostId, 'events.ndjson'),
      '{"garbage\n',
      'utf8'
    );
    await mkdir(path.join(repo.path, '.orcaops', 'artifacts', tailId), { recursive: true });
    await writeFile(
      path.join(repo.path, '.orcaops', 'artifacts', tailId, 'events.ndjson'),
      '{"partial',
      'utf8'
    );

    const res = await agent.runRaw(['doctor', '--json']);
    const r = JSON.parse(res.stdout) as DoctorReport;
    const check = findCheck(r, 'event-log-corruption');
    expect(check.status).toBe('fail');
    expect(check.details?.some((d) => d.includes(lostId))).toBe(true);
    // The benign crash tail on the OTHER artifact must not be hidden by
    // the failure — it silently blocks that artifact's captures.
    expect(check.details?.some((d) => d.includes(tailId) && d.includes('unterminated'))).toBe(true);
  });

  it('one uninspectable artifact log fails its check without discarding the doctor report', async () => {
    await agent.runRaw(['init', '--json', '--no-llm']);
    // A symlinked events.ndjson trips the containment guard (not ENOENT) —
    // the guarded check must fail alone, leaving the rest of the report
    // intact.
    const orphanId = '019fbbbb-0000-7000-8000-000000000abc';
    const dir = path.join(repo.path, '.orcaops', 'artifacts', orphanId);
    await mkdir(dir, { recursive: true });
    await symlink('/etc/hosts', path.join(dir, 'events.ndjson'));

    const res = await agent.runRaw(['doctor', '--json']);
    const r = JSON.parse(res.stdout) as DoctorReport;
    const check = findCheck(r, 'event-log-corruption');
    expect(check.status).toBe('fail');
    // The report survived AND the uninspectable artifact is named — one
    // bad log neither kills the report nor hides its own identity.
    expect(r.checks.length).toBeGreaterThan(10);
    expect(check.details?.some((d) => d.includes(orphanId))).toBe(true);
    // Uninspectable-only is NOT "0 corrupt lines": no loss was established
    // either way, so the summary must say what actually happened and the
    // lost-lines remediation must not appear.
    expect(check.summary).toMatch(/could not be inspected/);
    expect(check.summary).not.toMatch(/corrupt event-log lines/);
    expect(check.details?.some((d) => d.includes('Restore events.ndjson'))).toBe(false);
  });

  it('uninspectable summary still names capture-blocking crash tails beside it', async () => {
    await agent.runRaw(['init', '--json', '--no-llm']);
    const orphanId = '019fbbbb-0000-7000-8000-000000000abc';
    const dir = path.join(repo.path, '.orcaops', 'artifacts', orphanId);
    await mkdir(dir, { recursive: true });
    await symlink('/etc/hosts', path.join(dir, 'events.ndjson'));
    // A second artifact whose log ends in an unterminated partial write:
    // the tail blocks captures, so the summary must name both facts.
    const tailId = '019fbbbb-0000-7000-8000-000000000abd';
    const tailDir = path.join(repo.path, '.orcaops', 'artifacts', tailId);
    await mkdir(tailDir, { recursive: true });
    await writeFile(path.join(tailDir, 'events.ndjson'), '{"partial":', 'utf8');

    const res = await agent.runRaw(['doctor', '--json']);
    const r = JSON.parse(res.stdout) as DoctorReport;
    const check = findCheck(r, 'event-log-corruption');
    expect(check.status).toBe('fail');
    expect(check.summary).toMatch(/could not be inspected/);
    expect(check.summary).toMatch(/crash-truncated tail/);
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

  it('stale-artifacts warns when an active artifact has been idle >24h', async () => {
    await agent.runRaw(['init', '--scope', 'project', '--no-llm']);
    const plan = await agent.runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--input',
      inputFile(
        JSON.stringify({
          task: 'idle task',
          label: 'lbl',
          plan_steps: [{ text: 'step', label: 's1' }],
          touched_scope: [],
        })
      ),
    ]);
    expect(plan.exitCode).toBe(0);
    const artifactId = (JSON.parse(plan.stdout) as { artifact_id: string }).artifact_id;

    // Backdate started_at directly in SQLite to >24h ago.
    const { Store } = await import('@orcaops/storage');
    const dbPath = path.join(repo.path, '.orcaops', 'cache', 'orcaops.db');
    const store = new Store(dbPath);
    const db = store.db;
    const stale = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
    db.prepare(`UPDATE artifacts SET started_at = ? WHERE id = ?`).run(stale, artifactId);
    store.close();

    const res = await agent.runRaw(['doctor', '--json']);
    expect(res.exitCode).toBe(0);
    const r = JSON.parse(res.stdout) as DoctorReport;
    const check = findCheck(r, 'stale-artifacts');
    expect(check.status).toBe('warn');
    expect(check.summary).toMatch(/idle >24h/);
    expect(check.details?.some((d) => d.includes(artifactId))).toBe(true);
  });

  it('unresolved-blocks warns when latest run for an evaluator is severity=block + status=violation', async () => {
    await agent.runRaw(['init', '--scope', 'project', '--no-llm']);
    const plan = await agent.runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--input',
      inputFile(
        JSON.stringify({
          task: 'with block',
          label: 'lbl',
          plan_steps: [{ text: 'step', label: 's1' }],
          touched_scope: [],
        })
      ),
    ]);
    const artifactId = (JSON.parse(plan.stdout) as { artifact_id: string }).artifact_id;

    // Seed a pre-pr block violation via the typed storage API. The
    // raw-SQL seed would drift from the current column shape; the typed
    // helper writes against the current schema (evaluator_ref +
    // package_id + run_id + run_status + verdict + ...) and the
    // doctor check reads the materialized projection.
    await plantBlockViolation({
      cwd: repo.path,
      artifactId,
      evaluatorRef: 'test-pack/api-stub',
    });

    const res = await agent.runRaw(['doctor', '--json']);
    expect(res.exitCode).toBe(0);
    const r = JSON.parse(res.stdout) as DoctorReport;
    const check = findCheck(r, 'unresolved-blocks');
    expect(check.status).toBe('warn');
    expect(check.summary).toMatch(/1 unresolved/);
    expect(check.details?.some((d) => d.includes('test-pack/api-stub'))).toBe(true);
  });

  it('unresolved-blocks passes when a later "acknowledged" run supersedes the violation', async () => {
    await agent.runRaw(['init', '--scope', 'project', '--no-llm']);
    const plan = await agent.runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--input',
      inputFile(
        JSON.stringify({
          task: 'ack flow',
          label: 'lbl',
          plan_steps: [{ text: 'step', label: 's1' }],
          touched_scope: [],
        })
      ),
    ]);
    const artifactId = (JSON.parse(plan.stdout) as { artifact_id: string }).artifact_id;

    // Seed a violation + paired acknowledgment via the typed APIs.
    // The materialized projection now carries disposition='acknowledged'
    // on the violation row; the doctor check treats those as resolved.
    await plantAcknowledge({
      cwd: repo.path,
      artifactId,
      evaluatorRef: 'test-pack/api-stub',
    });

    const res = await agent.runRaw(['doctor', '--json']);
    expect(res.exitCode).toBe(0);
    const r = JSON.parse(res.stdout) as DoctorReport;
    expect(findCheck(r, 'unresolved-blocks').status).toBe('pass');
  });

  it('plan-idempotency: surfaces a planless reservation with the remedy', async () => {
    await agent.runRaw(['init', '--no-llm']);
    // An anchor capture whose reservation HAS a published plan — it must
    // not be flagged alongside the planless one.
    const plan = await agent.runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--input',
      inputFile(
        JSON.stringify({
          idempotency_key: 'published-key',
          task: 'anchor',
          label: 'anchor',
          plan_steps: [{ text: 's1', label: 's1' }],
          touched_scope: [],
        })
      ),
    ]);
    expect(plan.exitCode).toBe(0);
    // A crash between reserve and publish leaves the reservation with no
    // event witness anywhere — plant the row directly in the ledger.
    const planlessArtifact = '01999999-9999-7000-8000-0000000000ff';
    const { default: Database } = await import('better-sqlite3');
    const db = new Database(path.join(repo.path, '.orcaops', 'cache', 'orcaops.db'));
    try {
      db.prepare(
        `INSERT INTO plan_idempotency (idempotency_key, artifact_id, created_at)
         VALUES ('planless-key', ?, '2026-08-01T00:00:00.000Z')`
      ).run(planlessArtifact);
    } finally {
      db.close();
    }

    const res = await agent.runRaw(['doctor', '--json']);
    const c = findCheck(JSON.parse(res.stdout) as DoctorReport, 'plan-idempotency');
    expect(c.status).toBe('warn');
    expect(c.summary).toMatch(/1 planless/);
    expect(c.summary).toContain('IDEMPOTENCY_PENDING');
    const d = c.details?.join('\n') ?? '';
    expect(d).toContain('planless-key');
    expect(d).toContain(planlessArtifact);
    expect(c.details?.at(-1)).toBe(
      'Run `orcaops rebuild`, then retry `orcaops capture plan` with the same idempotency key. ' +
        'If it remains pending, run `orcaops doctor`; use a fresh key only after confirming ' +
        'that no plan was published and no capture is still running.'
    );
    expect(d).not.toContain('published-key');
  });

  it('plan-idempotency: passes when every reservation has a published plan', async () => {
    await agent.runRaw(['init', '--no-llm']);
    const res = await agent.runRaw(['doctor', '--json']);
    const c = findCheck(JSON.parse(res.stdout) as DoctorReport, 'plan-idempotency');
    expect(c.status).toBe('pass');
    expect(c.summary).toMatch(/all published/);
  });

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

  it('verifies all expected checks are present in the report (regression on accidentally dropping one)', async () => {
    await agent.runRaw(['init', '--scope', 'project', '--no-llm']);
    const res = await agent.runRaw(['doctor', '--json']);
    const r = JSON.parse(res.stdout) as DoctorReport;
    const names = r.checks.map((c) => c.name).sort();
    expect(names).toEqual([
      'aged-pin',
      'agent-skills',
      'agents-md',
      // Archive is enabled by default, so a fresh repo gets the complete
      // archive health family rather than the disabled-worktree nudge.
      'archive-identity',
      'archive-index',
      'archive-manifest-derivation',
      'archive-mirror-lag',
      'archive-perms',
      'archive-redaction',
      'block-skill-refs',
      'cache',
      'cloud-auth',
      'cloud-sync-pending',
      // `artifact-integrity` is omitted when clean, which it is here.
      'command-evaluator-trust',
      'config',
      'evaluator-dismiss-rate',
      'evaluator-provider-availability',
      'evaluators',
      'event-log-corruption',
      'fingerprint-zero-match',
      'generated-files',
      'git-hooks',
      'git-repo',
      'global-install',
      'index-conflicts',
      'info-exclude',
      'init',
      'lineage-orphan',
      'llm-tool',
      'materialized-disposition-consistency',
      'open-checkpoint-stale',
      'persistent-evaluator-errors',
      'personal-scope',
      'pin-displaced',
      'pin-orphan',
      'plan-idempotency',
      'review-cache-integrity',
      'same-session-multi-active',
      'scratch-checkouts',
      'seed',
      'session-hooks',
      'shell-key',
      'skill-drift',
      'skipped-fingerprint-rate',
      'skipped-run-analytics',
      'source-plan-pin-integrity',
      'stale-artifacts',
      'stale-baseline-refs',
      'stale-dispositions',
      'stale-pin',
      'stale-projection',
      'stale-snapshot-refs',
      'unresolved-blocks',
      'usage-source',
      'watch-companion',
    ]);
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

  it('stale-projection warns when plan_steps is empty but a plan was captured, and clears after rebuild', async () => {
    await agent.runRaw(['init', '--scope', 'project', '--no-llm']);
    const plan = await agent.runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--input',
      inputFile(
        JSON.stringify({
          task: 'projection staleness',
          label: 'projection staleness',
          plan_steps: [{ text: 'step one', label: 's1' }],
          touched_scope: [],
        })
      ),
    ]);
    expect(plan.exitCode).toBe(0);
    const artifactId = (JSON.parse(plan.stdout) as { artifact_id: string }).artifact_id;

    // Simulate a projection-dropping migration (e.g. 015/016) that ran
    // without a following rebuild: empty plan_steps while plan.json + the
    // plan_captured event remain the source of truth on disk.
    const { Store } = await import('@orcaops/storage');
    const dbPath = path.join(repo.path, '.orcaops', 'cache', 'orcaops.db');
    const store = new Store(dbPath);
    store.db.prepare(`DELETE FROM plan_steps WHERE artifact_id = ?`).run(artifactId);
    store.close();

    const warnRes = await agent.runRaw(['doctor', '--json']);
    const warned = findCheck(JSON.parse(warnRes.stdout) as DoctorReport, 'stale-projection');
    expect(warned.status).toBe('warn');
    expect(warned.details?.some((d) => d.includes(artifactId))).toBe(true);
    expect(warned.details?.some((d) => d.includes('orcaops rebuild'))).toBe(true);

    // `orcaops rebuild` re-projects plan_steps from the event log.
    const rebuildRes = await agent.runRaw(['rebuild', '--json']);
    expect(rebuildRes.exitCode).toBe(0);

    const passRes = await agent.runRaw(['doctor', '--json']);
    expect(findCheck(JSON.parse(passRes.stdout) as DoctorReport, 'stale-projection').status).toBe(
      'pass'
    );
  });

  it('stale-projection warns when a summary event has no summaries row, and clears after rebuild', async () => {
    await agent.runRaw(['init', '--scope', 'project', '--no-llm']);
    const plan = await agent.runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--input',
      inputFile(
        JSON.stringify({
          task: 'summary projection staleness',
          label: 'summary projection staleness',
          plan_steps: [{ text: 'step one', label: 's1' }],
          touched_scope: [],
        })
      ),
    ]);
    const artifactId = (JSON.parse(plan.stdout) as { artifact_id: string }).artifact_id;
    const summary = await agent.runRaw([
      'capture',
      'summary',
      '--input',
      inputFile(
        JSON.stringify({
          artifact_id: artifactId,
          outcome: 'shipped the reader',
          tests_written: [],
          tests_run: [],
          open_items: [],
          deferred_decisions: [],
        })
      ),
    ]);
    expect(summary.exitCode).toBe(0);

    // The crash shape this check was extended for: the durable
    // summary_captured event landed, the cache write never did.
    const { Store } = await import('@orcaops/storage');
    const dbPath = path.join(repo.path, '.orcaops', 'cache', 'orcaops.db');
    const store = new Store(dbPath);
    store.db.prepare('DELETE FROM summaries WHERE artifact_id = ?').run(artifactId);
    store.close();

    const warnRes = await agent.runRaw(['doctor', '--json']);
    const warned = findCheck(JSON.parse(warnRes.stdout) as DoctorReport, 'stale-projection');
    expect(warned.status).toBe('warn');
    expect(warned.details?.some((d) => d.includes(artifactId))).toBe(true);
    expect(warned.details?.some((d) => d.includes('summary_captured'))).toBe(true);
    expect(warned.details?.some((d) => d.includes('orcaops rebuild'))).toBe(true);
    // The remedy must steer away from the escalation that makes it worse.
    expect(warned.details?.some((d) => d.includes('Do not delete the artifact directory'))).toBe(
      true
    );

    expect((await agent.runRaw(['rebuild', '--json'])).exitCode).toBe(0);
    expect(
      findCheck(
        JSON.parse((await agent.runRaw(['doctor', '--json'])).stdout) as DoctorReport,
        'stale-projection'
      ).status
    ).toBe('pass');
  });

  it('serves a recovered artifact projection without writing during the doctor run', async () => {
    await agent.runRaw(['init', '--scope', 'project', '--no-llm']);
    const plan = await agent.runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--input',
      inputFile(
        JSON.stringify({
          task: 'corrupt me',
          label: 'corrupt me',
          plan_steps: [{ text: 'a', label: 'a' }],
          touched_scope: [],
        })
      ),
    ]);
    const artifactId = (JSON.parse(plan.stdout) as { artifact_id: string }).artifact_id;

    // Corrupt the on-disk projection: valid JSON, wrong shape. The strict
    // parse now happens INSIDE the recovery seam, so with an intact event
    // log the projection is rebuilt rather than the artifact becoming
    // unreadable (pre-fix this shape either replaced the whole report or
    // counted the artifact as unreadable-skipped).
    const { artifactJson } = artifactPathsFor(repo.path, getDefaultConfig(), artifactId);
    const corruptProjection = '{"id":"not-a-valid-artifact-shape"}';
    await writeFile(artifactJson, corruptProjection, 'utf8');

    const res = await agent.runRaw(['doctor', '--json']);
    const r = JSON.parse(res.stdout) as DoctorReport;
    // A full report came back — NOT an error envelope (`ok:false`).
    expect(r.ok).toBe(true);
    expect(r.checks.length).toBeGreaterThan(0);
    const c = findCheck(r, 'source-plan-pin-integrity');
    expect(c.status).toBe('pass');
    expect(c.summary).toBe('no pinned source plans');
    // Recovery is serve-only: doctor consumes the event-derived view but
    // cannot race a writer or resurrect a concurrently deleted artifact.
    expect(await readFile(artifactJson, 'utf8')).toBe(corruptProjection);
  });

  it('source-plan-pin-integrity: passes (all content hashes match) for an untampered pin', async () => {
    await agent.runRaw(['init', '--scope', 'project', '--no-llm']);
    const planFile = path.join(repo.path, 'clean-pin.md');
    await writeFile(planFile, '# Clean pin\n\nuntampered content\n', 'utf8');
    await agent.runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--source-plan',
      planFile,
      '--input',
      inputFile(
        JSON.stringify({
          task: 'clean pin',
          label: 'clean pin',
          plan_steps: [{ text: 'a', label: 'a' }],
          touched_scope: [],
        })
      ),
    ]);

    const res = await agent.runRaw(['doctor', '--json']);
    const c = findCheck(JSON.parse(res.stdout) as DoctorReport, 'source-plan-pin-integrity');
    expect(c.status).toBe('pass');
    expect(c.summary).toMatch(/all content hashes match/);
  });

  it('source-plan-pin-integrity: warns when a pinned plan content drifts from its hash', async () => {
    await agent.runRaw(['init', '--scope', 'project', '--no-llm']);
    const planFile = path.join(repo.path, 'pinned-plan.md');
    await writeFile(planFile, '# Pinned plan\n\nthe original content\n', 'utf8');
    const plan = await agent.runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--source-plan',
      planFile,
      '--input',
      inputFile(
        JSON.stringify({
          task: 'pinned thing',
          label: 'pinned thing',
          plan_steps: [{ text: 'a', label: 'a' }],
          touched_scope: [],
        })
      ),
    ]);
    const artifactId = (JSON.parse(plan.stdout) as { artifact_id: string }).artifact_id;

    // Tamper the pinned content on disk so sha256(content) no longer equals the
    // stored hash (the pin schema only requires non-empty content+hash, not that
    // they agree — exactly the drift this check exists to catch).
    const { artifactJson } = artifactPathsFor(repo.path, getDefaultConfig(), artifactId);
    const projection = JSON.parse(await readFile(artifactJson, 'utf8')) as {
      source_plan: { content: string; hash: string };
    };
    projection.source_plan.content += '\n<tampered>';
    await writeFile(artifactJson, JSON.stringify(projection, null, 2), 'utf8');

    const res = await agent.runRaw(['doctor', '--json']);
    const c = findCheck(JSON.parse(res.stdout) as DoctorReport, 'source-plan-pin-integrity');
    expect(c.status).toBe('warn');
    expect(c.summary).toMatch(/drifted from their content hash/);
    expect(c.details?.some((d) => d.includes(artifactId))).toBe(true);
  });

  it('review-cache-integrity: passes with no review-pull records', async () => {
    await agent.runRaw(['init', '--scope', 'project', '--no-llm']);
    const res = await agent.runRaw(['doctor', '--json']);
    const c = findCheck(JSON.parse(res.stdout) as DoctorReport, 'review-cache-integrity');
    expect(c.status).toBe('pass');
    expect(c.summary).toMatch(/no review-pull records/);
  });

  it('review-cache-integrity: passes for clean review-pull records', async () => {
    await agent.runRaw(['init', '--scope', 'project', '--no-llm']);
    await writeReviewPullRecord(sourcePlanCacheDir(repo.path), reviewCandidate('clean body'));
    const res = await agent.runRaw(['doctor', '--json']);
    const c = findCheck(JSON.parse(res.stdout) as DoctorReport, 'review-cache-integrity');
    expect(c.status).toBe('pass');
    expect(c.summary).toMatch(/1 review-pull record\(s\); all content hashes match/);
  });

  it('review-cache-integrity: warns when a cached review body drifts from its hash', async () => {
    await agent.runRaw(['init', '--scope', 'project', '--no-llm']);
    const { recordPath } = await writeReviewPullRecord(
      sourcePlanCacheDir(repo.path),
      reviewCandidate('the reviewed body')
    );
    // Tamper the body on disk (writeReviewPullRecord enforces the hash, so the
    // drift this check exists to catch can only arise behind its back).
    const onDisk = JSON.parse(await readFile(recordPath, 'utf8')) as { body: string };
    onDisk.body = 'a body the user never reviewed';
    await writeFile(recordPath, JSON.stringify(onDisk, null, 2), 'utf8');

    const res = await agent.runRaw(['doctor', '--json']);
    const c = findCheck(JSON.parse(res.stdout) as DoctorReport, 'review-cache-integrity');
    expect(c.status).toBe('warn');
    expect(c.summary).toMatch(/drifted from their content hash/);
    expect(c.details?.some((d) => d.includes('ext-review-1'))).toBe(true);
    expect(c.details?.some((d) => d.includes('plan review pull'))).toBe(true);
  });

  it('review-cache-integrity: reports an unsafe cache symlink as a failed check', async () => {
    await agent.runRaw(['init', '--no-llm']);
    const outside = await mkdtemp(path.join(tmpdir(), 'orcaops-doctor-review-cache-'));
    try {
      const reviewCache = path.join(repo.path, '.orcaops', 'cache', 'source-plan');
      await mkdir(path.dirname(reviewCache), { recursive: true });
      await rm(reviewCache, { recursive: true, force: true });
      await symlink(outside, reviewCache);

      const res = await agent.runRaw(['doctor', '--json']);
      expect(res.exitCode).toBe(1);
      const report = JSON.parse(res.stdout) as DoctorReport;
      expect(report.ok).toBe(true);
      const c = findCheck(report, 'review-cache-integrity');
      expect(c.status).toBe('fail');
      expect(c.summary).toMatch(/must not contain symlinks/);
      expect(c.details?.join('\n')).toMatch(/inspectable directory inside the repository/);
      expect(res.stderr).not.toContain('Internal error:');
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('review-cache-integrity: reports an uninspectable cache path as a failed check', async () => {
    await agent.runRaw(['init', '--no-llm']);
    const reviewCache = path.join(repo.path, '.orcaops', 'cache', 'source-plan');
    await mkdir(reviewCache, { recursive: true });
    await writeFile(path.join(reviewCache, 'review-pull'), 'not a directory', 'utf8');

    const res = await agent.runRaw(['doctor', '--json']);
    expect(res.exitCode).toBe(1);
    const report = JSON.parse(res.stdout) as DoctorReport;
    const c = findCheck(report, 'review-cache-integrity');
    expect(c.status).toBe('fail');
    expect(c.summary).toMatch(/ENOTDIR|not a directory/i);
    expect(c.details?.join('\n')).toMatch(/inspectable directory inside the repository/);
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
  describe('lineage-orphan check', () => {
    it('passes when there are no captured artifacts', async () => {
      await agent.runRaw(['init', '--scope', 'project', '--no-llm']);
      const res = await agent.runRaw(['doctor', '--json']);
      const r = JSON.parse(res.stdout) as DoctorReport;
      const check = findCheck(r, 'lineage-orphan');
      expect(check.status).toBe('pass');
      expect(check.summary).toMatch(/no captured artifacts/);
    });

    it('passes when every artifact lineage SHA is reachable from a local branch tip', async () => {
      await agent.runRaw(['init', '--scope', 'project', '--no-llm']);
      await agent.runRaw([
        'capture',
        'plan',
        '--no-llm',
        '--input',
        inputFile(JSON.stringify({ task: 't', plan_steps: [{ text: 's', label: 's1' }] })),
      ]);
      const res = await agent.runRaw(['doctor', '--json']);
      const r = JSON.parse(res.stdout) as DoctorReport;
      const check = findCheck(r, 'lineage-orphan');
      expect(check.status).toBe('pass');
      expect(check.summary).toMatch(/all latest lineage SHAs reachable/);
    });

    it('warns when an artifact lineage SHA is unreachable from any local branch (orphaned by hard reset)', async () => {
      await agent.runRaw(['init', '--scope', 'project', '--no-llm']);
      const planRes = await agent.runRaw([
        'capture',
        'plan',
        '--no-llm',
        '--input',
        inputFile(
          JSON.stringify({ task: 'will be orphaned', plan_steps: [{ text: 's', label: 's1' }] })
        ),
      ]);
      const plan = JSON.parse(planRes.stdout) as { artifact_id: string; head_sha: string };

      // Move HEAD forward, then hard-reset back to before the artifact
      // was captured. The artifact's recorded lineage SHA is no longer
      // reachable from any branch tip.
      const { gitClient } = await import('@orcaops/test-harness');
      const git = gitClient(repo.path);
      const initialSha = await git.revparse(['HEAD~0']);
      // The artifact's plan was captured at HEAD; we need to roll back
      // to before that. Use HEAD~1 (the original initial commit).
      const initialCommit = (await git.log()).all.at(-1);
      if (!initialCommit) throw new Error('initial commit not found');
      // Add a new commit so that HEAD has moved forward; then reset to
      // the initial commit so the artifact's lineage SHA is the moved-forward one
      // (which is now unreachable).
      await writeFile(path.join(repo.path, 'forward.ts'), 'forward\n', 'utf8');
      await git.add('forward.ts');
      await git.commit('forward step');
      const forwardSha = await git.revparse(['HEAD']);

      // Now run sync so the artifact's lineage SHA = forwardSha.
      await agent.runRaw(['lineage', '--json']);

      // Hard reset to the original commit; forwardSha becomes unreachable.
      await git.reset(['--hard', initialCommit.hash]);
      // Sanity: HEAD is back, forwardSha is no longer pointed at.
      expect(await git.revparse(['HEAD'])).not.toBe(forwardSha);
      expect(initialSha).not.toBe(forwardSha);

      const res = await agent.runRaw(['doctor', '--json']);
      const r = JSON.parse(res.stdout) as DoctorReport;
      const check = findCheck(r, 'lineage-orphan');
      expect(check.status).toBe('warn');
      expect(check.summary).toMatch(/1 of 1 artifact/);
      expect(check.details?.some((d) => d.includes(plan.artifact_id))).toBe(true);
      expect(check.details?.some((d) => d.includes('orcaops lineage'))).toBe(true);
    });
  });

  // ── evaluator-dismiss-rate check ────────────────────────────────────
  describe('evaluator-dismiss-rate check', () => {
    it('passes when no evaluator has enough runs to compute a meaningful rate', async () => {
      await agent.runRaw(['init', '--scope', 'project', '--no-llm']);
      await agent.runRaw([
        'capture',
        'plan',
        '--no-llm',
        '--input',
        inputFile(JSON.stringify({ task: 't', plan_steps: [{ text: 's', label: 's1' }] })),
      ]);
      const res = await agent.runRaw(['doctor', '--json']);
      const r = JSON.parse(res.stdout) as DoctorReport;
      const check = findCheck(r, 'evaluator-dismiss-rate');
      expect(check.status).toBe('pass');
      expect(check.summary).toMatch(/not enough signal/);
    });

    it('warns when an evaluator is dismissed > 50% of >= 3 runs', async () => {
      await agent.runRaw(['init', '--scope', 'project', '--no-llm']);
      // Install the test-pack so the discovery-routed `block dismiss`
      // resolves `test-pack/api-stub` (init does not auto-install packs).
      await installTestPack(agent);
      // Plant 4 violations on 4 different artifacts, then dismiss 3 of them.
      const ids: string[] = [];
      for (let i = 0; i < 4; i++) {
        const planRes = await agent.runRaw([
          'capture',
          'plan',
          '--no-llm',
          '--input',
          inputFile(JSON.stringify({ task: `t${i}`, plan_steps: [{ text: 's', label: 's1' }] })),
        ]);
        const plan = JSON.parse(planRes.stdout) as { artifact_id: string };
        ids.push(plan.artifact_id);
        await plantBlockViolation({
          cwd: repo.path,
          artifactId: plan.artifact_id,
          evaluatorRef: 'test-pack/api-stub',
        });
      }
      // Dismiss 3 of 4 → 75% dismiss rate (will hit warn threshold).
      // The 4 violations + 3 dismisses = 7 total runs of the evaluator.
      for (let i = 0; i < 3; i++) {
        const res = await agent.runRaw([
          'block',
          'dismiss',
          '--artifact',
          ids[i],
          '--evaluator',
          'test-pack/api-stub',
          '--reason',
          'fp',
        ]);
        expect(res.exitCode).toBe(0);
      }
      const res = await agent.runRaw(['doctor', '--json']);
      const r = JSON.parse(res.stdout) as DoctorReport;
      const check = findCheck(r, 'evaluator-dismiss-rate');
      expect(check.status).toBe('warn');
      expect(check.summary).toMatch(/^1 of \d+ evaluator/);
      expect(check.details?.some((d) => d.includes('test-pack/api-stub'))).toBe(true);
    });

    it('passes when an evaluator is dismissed BELOW the threshold', async () => {
      await agent.runRaw(['init', '--scope', 'project', '--no-llm']);
      await installTestPack(agent);
      // The dismiss-rate denominator is the count
      // of disposition rows + pass-verdict runs (≥ 3 to compute a
      // meaningful rate). Seed 4 violations + dismiss 1 (`dismissed`
      // disposition) + acknowledge 3 (each `acknowledged` disposition)
      // → 4 resolutions, 1 dismissed = 25% (below 50%) → pass.
      const ids: string[] = [];
      for (let i = 0; i < 4; i++) {
        const planRes = await agent.runRaw([
          'capture',
          'plan',
          '--no-llm',
          '--input',
          inputFile(JSON.stringify({ task: `t${i}`, plan_steps: [{ text: 's', label: 's1' }] })),
        ]);
        ids.push((JSON.parse(planRes.stdout) as { artifact_id: string }).artifact_id);
        await plantBlockViolation({
          cwd: repo.path,
          artifactId: ids[i],
          evaluatorRef: 'test-pack/api-stub',
        });
      }
      // 1 dismiss + 3 acknowledges = 4 dispositions, 1 dismiss / 4
      // resolutions = 25%.
      const dismissRes = await agent.runRaw([
        'block',
        'dismiss',
        '--artifact',
        ids[0],
        '--evaluator',
        'test-pack/api-stub',
        '--reason',
        'fp',
      ]);
      expect(dismissRes.exitCode).toBe(0);
      for (let i = 1; i < 4; i++) {
        const ackRes = await agent.runRaw([
          'block',
          'acknowledge',
          '--artifact',
          ids[i],
          '--evaluator',
          'test-pack/api-stub',
          '--reason',
          'ok',
        ]);
        expect(ackRes.exitCode).toBe(0);
      }
      const res = await agent.runRaw(['doctor', '--json']);
      const r = JSON.parse(res.stdout) as DoctorReport;
      const check = findCheck(r, 'evaluator-dismiss-rate');
      expect(check.status).toBe('pass');
      expect(check.summary).toMatch(/none above 50% dismiss rate/);
    });

    /**
     * Plant a closed checkpoint with `policy_exceptions[]` AND a paired
     * `evaluator_disposition_recorded` event matching what the real CLI
     * `capture checkpoint open` flow mints (see
     * `apps/orcaops-cli/src/commands/capture/checkpoint.ts`).
     * Used to verify that the dismiss-rate SQL counts `policy-excepted`
     * dispositions alongside `dismissed` ones. The disposition
     * is the actual signal the doctor SQL reads (not the cp's JSON
     * array); writing both keeps the seed faithful to production
     * semantics rather than only the lower-level storage shape.
     */
    async function plantClosedCpWithPolicyException(
      cwd: string,
      artifactId: string,
      evaluatorRef: string,
      keySuffix: string
    ): Promise<void> {
      const { ArtifactStore, uuidv7 } = await import('@orcaops/storage');
      const { loadConfig } = await import('@orcaops/core');
      const config = await loadConfig(cwd);
      const store = new ArtifactStore({ repoRoot: cwd, config });
      try {
        const planRev = store.store.getLatestPlanRevision(artifactId);
        const firstStep = planRev?.steps[0]?.step_id;
        if (!firstStep) {
          throw new Error(
            `plantClosedCpWithPolicyException: no plan steps found for ${artifactId}`
          );
        }
        // Plant a blocking violation run that the policy exception will
        // resolve. Production: the run is one of the cp-open dispatch
        // results; here we mint it directly to mirror the same shape.
        const runId = uuidv7();
        const [packageId, evaluatorId] = evaluatorRef.split('/');
        const violationTs = new Date().toISOString();
        await store.writeEvaluatorRunPayload(artifactId, {
          schema: 'orcaops.evaluator_run/v1',
          run_id: runId,
          artifact_id: artifactId,
          evaluator_ref: evaluatorRef,
          package_id: packageId,
          evaluator_id: evaluatorId,
          phase: 'checkpoint-open',
          severity: 'block',
          run_status: 'completed',
          verdict: 'violation',
          body: 'VIOLATION\n\nseeded for policy-exception test',
          ts: violationTs,
        });
        await store.writeCheckpointOpened(
          {
            artifact_id: artifactId,
            declared_step_ids: [firstStep],
            policy_exceptions: [{ evaluator: evaluatorRef, reason: 'intentional bypass' }],
          },
          { idempotencyKey: `pe-cp-open-${keySuffix}`, headSha: 'cafef00d' }
        );
        // Mint the paired policy-excepted disposition that the real
        // CLI flow writes alongside the cp open (checkpoint.ts:185-192).
        await store.writeEvaluatorDisposition(artifactId, {
          schema: 'orcaops.evaluator_disposition/v1',
          disposition_id: uuidv7(),
          artifact_id: artifactId,
          run_id: runId,
          evaluator_ref: evaluatorRef,
          disposition: 'policy-excepted',
          reason: 'intentional bypass',
          agent_session_id: null,
          ts: new Date().toISOString(),
        });
        await store.writeCheckpointClosed(
          {
            artifact_id: artifactId,
            n: 1,
            summary: 'closed with exception',
            files_changed: [],
            decisions: [],
            uncertainty: [],
            done_criteria: [],
            completed_step_ids: [],
            head_sha: 'aaaa1111',
          },
          { idempotencyKey: `pe-cp-close-${keySuffix}` }
        );
      } finally {
        store.close();
      }
    }

    it('union: counts policy_exceptions[] alongside evaluator_runs.dismissed in dismiss-rate denominator', async () => {
      await agent.runRaw(['init', '--scope', 'project', '--no-llm']);
      // 4 artifacts. On 2 of them, plant a `dismissed` evaluator_run.
      // On the other 2, plant a closed cp with a policy_exception
      // naming the same evaluator. Total contributions to the
      // evaluator's dismiss-counter: 2 + 2 = 4 (≥ MIN_RUNS=3).
      // 100% dismiss rate (everything in the denominator is also in
      // the numerator), so the check warns.
      const ids: string[] = [];
      for (let i = 0; i < 4; i++) {
        const planRes = await agent.runRaw([
          'capture',
          'plan',
          '--no-llm',
          '--input',
          inputFile(JSON.stringify({ task: `t${i}`, plan_steps: [{ text: 's', label: 's1' }] })),
        ]);
        ids.push((JSON.parse(planRes.stdout) as { artifact_id: string }).artifact_id);
      }
      // Two artifacts: plant a violation + a paired `dismissed`
      // disposition directly via the typed storage API. Direct seed
      // is the right shape for this test — it asserts the dismiss-
      // rate SQL's UNION over `evaluator_runs.disposition='dismissed'`
      // plus `evaluator_dispositions.disposition='policy-excepted'`.
      // The CLI `block dismiss` path is exercised in the per-evaluator
      // dismiss-rate test above.
      const { ArtifactStore: DStore, uuidv7: mintId } = await import('@orcaops/storage');
      const { loadConfig: loadCfg } = await import('@orcaops/core');
      for (let i = 0; i < 2; i++) {
        const runId = await plantBlockViolation({
          cwd: repo.path,
          artifactId: ids[i],
          evaluatorRef: 'test-pack/scope-density-stub',
        });
        const cfg = await loadCfg(repo.path);
        const dStore = new DStore({ repoRoot: repo.path, config: cfg });
        try {
          await dStore.writeEvaluatorDisposition(ids[i], {
            schema: 'orcaops.evaluator_disposition/v1',
            disposition_id: mintId(),
            artifact_id: ids[i],
            run_id: runId,
            evaluator_ref: 'test-pack/scope-density-stub',
            disposition: 'dismissed',
            reason: 'fp',
            agent_session_id: null,
            ts: new Date().toISOString(),
          });
        } finally {
          dStore.close();
        }
      }
      // Two artifacts: dismiss-by-policy-exception (open cp with the
      // evaluator named in policy_exceptions, then close).
      for (let i = 2; i < 4; i++) {
        await plantClosedCpWithPolicyException(
          repo.path,
          ids[i],
          'test-pack/scope-density-stub',
          `${i}`
        );
      }
      const res = await agent.runRaw(['doctor', '--json']);
      const r = JSON.parse(res.stdout) as DoctorReport;
      const check = findCheck(r, 'evaluator-dismiss-rate');
      // Without the UNION, only 2 evaluator_runs.dismissed for
      // test-pack/scope-density-stub would count toward the
      // denominator (below MIN_RUNS=3); with the UNION, the
      // denominator hits 4 → the evaluator is flagged.
      expect(check.status).toBe('warn');
      expect(check.details?.some((d) => d.includes('test-pack/scope-density-stub'))).toBe(true);
      // 4 dismissals (2 evaluator_runs + 2 policy_exceptions) over 4
      // resolutions = 100%.
      expect(check.details?.some((d) => /4\/4 .*100%/.test(d))).toBe(true);
    });

    it('a high acknowledge rate does NOT trigger the warning (acks are not dismissals)', async () => {
      await agent.runRaw(['init', '--scope', 'project', '--no-llm']);
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) {
        const planRes = await agent.runRaw([
          'capture',
          'plan',
          '--no-llm',
          '--input',
          inputFile(JSON.stringify({ task: `t${i}`, plan_steps: [{ text: 's', label: 's1' }] })),
        ]);
        ids.push((JSON.parse(planRes.stdout) as { artifact_id: string }).artifact_id);
        await plantBlockViolation({
          cwd: repo.path,
          artifactId: ids[i],
          evaluatorRef: 'test-pack/api-stub',
        });
      }
      // Acknowledge all three (api-signature-drift's on_block opts in).
      for (const id of ids) {
        await agent.runRaw([
          'block',
          'acknowledge',
          '--artifact',
          id,
          '--evaluator',
          'api-signature-drift',
          '--reason',
          'intentional',
        ]);
      }
      const res = await agent.runRaw(['doctor', '--json']);
      const r = JSON.parse(res.stdout) as DoctorReport;
      const check = findCheck(r, 'evaluator-dismiss-rate');
      expect(check.status).toBe('pass');
    });
  });

  // ── per-check doctor trigger tests ─────────────────────────────────────
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

    it('stale-dispositions warns when an evaluator_disposition is older than disposition_ttl_days', async () => {
      await agent.runRaw(['init', '--scope', 'project', '--no-llm']);
      const planRes = await agent.runRaw([
        'capture',
        'plan',
        '--no-llm',
        '--input',
        inputFile(JSON.stringify({ task: 't', plan_steps: [{ text: 's', label: 's1' }] })),
      ]);
      const artifactId = (JSON.parse(planRes.stdout) as { artifact_id: string }).artifact_id;

      // The check filters evaluator_dispositions by ts < now - ttl_days
      // (default 90). Seed a row dated 100 days ago. writeEvaluatorDisposition
      // requires a paired run; seed both via writeEvaluatorRunPayload +
      // writeEvaluatorDisposition.
      const { ArtifactStore, uuidv7 } = await import('@orcaops/storage');
      const { loadConfig } = await import('@orcaops/core');
      const config = await loadConfig(repo.path);
      const store = new ArtifactStore({ repoRoot: repo.path, config });
      try {
        const runId = uuidv7();
        const oldTs = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString();
        await store.writeEvaluatorRunPayload(artifactId, {
          schema: 'orcaops.evaluator_run/v1',
          run_id: runId,
          artifact_id: artifactId,
          evaluator_ref: 'test-pack/stale',
          package_id: 'test-pack',
          evaluator_id: 'stale',
          phase: 'pre-pr',
          severity: 'block',
          run_status: 'completed',
          verdict: 'violation',
          body: 'VIOLATION',
          ts: oldTs,
        });
        await store.writeEvaluatorDisposition(artifactId, {
          schema: 'orcaops.evaluator_disposition/v1',
          disposition_id: uuidv7(),
          artifact_id: artifactId,
          run_id: runId,
          evaluator_ref: 'test-pack/stale',
          disposition: 'dismissed',
          reason: 'stale test',
          agent_session_id: null,
          ts: oldTs,
        });
      } finally {
        store.close();
      }

      const res = await agent.runRaw(['doctor', '--json']);
      const r = JSON.parse(res.stdout) as DoctorReport;
      const check = findCheck(r, 'stale-dispositions');
      expect(check.status).toBe('warn');
      expect(check.details?.some((d) => d.includes('test-pack/stale'))).toBe(true);
    });

    it('skipped-run-analytics warns when an evaluator has ≥70% skip rate over ≥5 runs', async () => {
      await agent.runRaw(['init', '--scope', 'project', '--no-llm']);
      const planRes = await agent.runRaw([
        'capture',
        'plan',
        '--no-llm',
        '--input',
        inputFile(JSON.stringify({ task: 't', plan_steps: [{ text: 's', label: 's1' }] })),
      ]);
      const artifactId = (JSON.parse(planRes.stdout) as { artifact_id: string }).artifact_id;

      // Seed 7 runs for one ref: 6 skipped + 1 completed → 85.7% skip rate
      // over 7 runs (≥ 5 minimum, ≥ 70% threshold).
      const { ArtifactStore, uuidv7 } = await import('@orcaops/storage');
      const { loadConfig } = await import('@orcaops/core');
      const config = await loadConfig(repo.path);
      const store = new ArtifactStore({ repoRoot: repo.path, config });
      try {
        for (let i = 0; i < 6; i++) {
          await store.writeEvaluatorRunPayload(artifactId, {
            schema: 'orcaops.evaluator_run/v1',
            run_id: uuidv7(),
            artifact_id: artifactId,
            evaluator_ref: 'test-pack/skippy',
            package_id: 'test-pack',
            evaluator_id: 'skippy',
            phase: 'post-plan',
            severity: 'warn',
            run_status: 'skipped',
            verdict: null,
            body: 'SKIPPED\n\ntest seed',
            ts: new Date(Date.now() - (10 - i) * 1000).toISOString(),
          });
        }
        await store.writeEvaluatorRunPayload(artifactId, {
          schema: 'orcaops.evaluator_run/v1',
          run_id: uuidv7(),
          artifact_id: artifactId,
          evaluator_ref: 'test-pack/skippy',
          package_id: 'test-pack',
          evaluator_id: 'skippy',
          phase: 'post-plan',
          severity: 'warn',
          run_status: 'completed',
          verdict: 'pass',
          body: 'PASS',
          ts: new Date().toISOString(),
        });
      } finally {
        store.close();
      }

      const res = await agent.runRaw(['doctor', '--json']);
      const r = JSON.parse(res.stdout) as DoctorReport;
      const check = findCheck(r, 'skipped-run-analytics');
      expect(check.status).toBe('warn');
      expect(check.details?.some((d) => d.includes('test-pack/skippy'))).toBe(true);
    });

    it('materialized-disposition-consistency FAILS when materialized differs from the latest disposition event', async () => {
      // This condition is a failure rather than a warning. The
      // check's SQL filters `r.disposition IS NOT NULL AND
      // r.disposition != 'unresolved' AND r.disposition !=
      // l.disposition`, so the seed needs two distinct non-null
      // disposition values. Typed APIs auto-materialize the row's
      // disposition from the latest event, so the divergence is
      // intentionally constructed via raw SQL.
      await agent.runRaw(['init', '--scope', 'project', '--no-llm']);
      const planRes = await agent.runRaw([
        'capture',
        'plan',
        '--no-llm',
        '--input',
        inputFile(JSON.stringify({ task: 't', plan_steps: [{ text: 's', label: 's1' }] })),
      ]);
      const artifactId = (JSON.parse(planRes.stdout) as { artifact_id: string }).artifact_id;

      const { ArtifactStore, Store, uuidv7 } = await import('@orcaops/storage');
      const { loadConfig } = await import('@orcaops/core');
      const config = await loadConfig(repo.path);
      const aStore = new ArtifactStore({ repoRoot: repo.path, config });
      const runId = uuidv7();
      try {
        await aStore.writeEvaluatorRunPayload(artifactId, {
          schema: 'orcaops.evaluator_run/v1',
          run_id: runId,
          artifact_id: artifactId,
          evaluator_ref: 'test-pack/api-stub',
          package_id: 'test-pack',
          evaluator_id: 'api-stub',
          phase: 'pre-pr',
          severity: 'block',
          run_status: 'completed',
          verdict: 'violation',
          body: 'VIOLATION',
          ts: new Date().toISOString(),
        });
        await aStore.writeEvaluatorDisposition(artifactId, {
          schema: 'orcaops.evaluator_disposition/v1',
          disposition_id: uuidv7(),
          artifact_id: artifactId,
          run_id: runId,
          evaluator_ref: 'test-pack/api-stub',
          disposition: 'dismissed',
          reason: 'first',
          agent_session_id: null,
          ts: new Date(Date.now() - 1000).toISOString(),
        });
      } finally {
        aStore.close();
      }

      // Now diverge: insert a second, later disposition event with a
      // DIFFERENT value, without going through writeEvaluatorDisposition
      // (which would re-materialize the run's disposition column).
      const dbPath = path.join(repo.path, '.orcaops', 'cache', 'orcaops.db');
      const store = new Store(dbPath);
      try {
        store.db
          .prepare(
            `INSERT INTO evaluator_dispositions
               (disposition_id, artifact_id, run_id, evaluator_ref,
                disposition, reason, agent_session_id, ts,
                source_event_index, local_kind_rank, local_index)
             VALUES (?, ?, ?, ?, 'acknowledged', 'later', NULL, ?,
                     ?, 1, 0)`
          )
          .run(
            uuidv7(),
            artifactId,
            runId,
            'test-pack/api-stub',
            new Date().toISOString(),
            // source_event_index must be unique per artifact and
            // higher than any existing; pick a large value.
            999_999
          );
      } finally {
        store.close();
      }

      const res = await agent.runRaw(['doctor', '--json']);
      // Failing check ⇒ overall fail ⇒ exit 1.
      const r = JSON.parse(res.stdout) as DoctorReport;
      const check = findCheck(r, 'materialized-disposition-consistency');
      expect(check.status).toBe('fail');
      expect(check.details?.some((d) => d.includes('test-pack/api-stub'))).toBe(true);
    });

    it('persistent-evaluator-errors warns when one ref has 3 consecutive error runs', async () => {
      await agent.runRaw(['init', '--scope', 'project', '--no-llm']);
      const planRes = await agent.runRaw([
        'capture',
        'plan',
        '--no-llm',
        '--input',
        inputFile(JSON.stringify({ task: 't', plan_steps: [{ text: 's', label: 's1' }] })),
      ]);
      const artifactId = (JSON.parse(planRes.stdout) as { artifact_id: string }).artifact_id;

      const { ArtifactStore, uuidv7 } = await import('@orcaops/storage');
      const { loadConfig } = await import('@orcaops/core');
      const config = await loadConfig(repo.path);
      const store = new ArtifactStore({ repoRoot: repo.path, config });
      try {
        for (let i = 0; i < 3; i++) {
          await store.writeEvaluatorRunPayload(artifactId, {
            schema: 'orcaops.evaluator_run/v1',
            run_id: uuidv7(),
            artifact_id: artifactId,
            evaluator_ref: 'test-pack/persistent-err',
            package_id: 'test-pack',
            evaluator_id: 'persistent-err',
            phase: 'post-plan',
            severity: 'warn',
            run_status: 'error',
            verdict: null,
            body: `ERROR\n\nintentional error ${i + 1}`,
            error: { code: 'TEST_ERROR', message: `iteration ${i + 1}` },
            ts: new Date(Date.now() - (3 - i) * 1000).toISOString(),
          });
        }
      } finally {
        store.close();
      }

      const res = await agent.runRaw(['doctor', '--json']);
      const r = JSON.parse(res.stdout) as DoctorReport;
      const check = findCheck(r, 'persistent-evaluator-errors');
      expect(check.status).toBe('warn');
      expect(check.details?.some((d) => d.includes('test-pack/persistent-err'))).toBe(true);
    });
  });
});

// ── snapshot / fingerprint doctor checks ───────────────────────────

describe('orcaops doctor — snapshot/fingerprint checks', () => {
  let repo: TempRepo;
  let agent: ReturnType<typeof makeAgent>;

  // `init` is identical for every test here and costs ~450ms; run it once
  // and give each test a ~20ms copy of the result.
  const template = createRepoTemplate(
    async (repoPath) => {
      await makeAgent({
        cwd: repoPath,
        env: { CLAUDE_SESSION_ID: 'test-doctor-s6', ORCAOPS_DISABLE_DRAIN: '1' },
      }).runRaw(['init', '--scope', 'project', '--json', '--no-llm']);
    },
    { initialBranch: 'main' }
  );

  beforeEach(async () => {
    repo = await template.checkout();
    // Drain disabled so the snapshot/fingerprint checks run with no cloud
    // I/O; captures mint real refs regardless of auth state. Scoped to
    // THIS describe — the preceding evaluator-health group runs against an empty store
    // for its cloud-auth check.
    agent = makeAgent({
      cwd: repo.path,
      env: { CLAUDE_SESSION_ID: 'test-doctor-s6', ORCAOPS_DISABLE_DRAIN: '1' },
    });
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  afterAll(async () => {
    await template.destroy();
  });

  function doctor(): Promise<{ stdout: string; exitCode: number }> {
    return agent.runRaw(['doctor', '--json']);
  }
  function report(stdout: string): DoctorReport {
    return JSON.parse(stdout) as DoctorReport;
  }

  async function planOpenClose(opts: { disableFp?: boolean } = {}): Promise<string> {
    const pr = await agent.runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--input',
      inputFile(
        JSON.stringify({
          idempotency_key: `plan-${randomUUID()}`,
          task: 'doctor snapshot fixture',
          label: 'doctor-snapshot-fixture',
          plan_steps: [{ text: 'step a', label: 's1' }],
          touched_scope: [],
        })
      ),
    ]);
    const plan = JSON.parse(pr.stdout) as {
      artifact_id: string;
      plan_steps: Array<{ step_id: string }>;
    };
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
          declared_step_ids: [plan.plan_steps[0].step_id],
        })
      ),
    ]);
    await commitFile(repo.path, `src/${randomUUID()}.ts`, 'export const x = 1;\n', 'work');
    if (opts.disableFp) {
      const cfgPath = await effectiveConfigPath(repo.path);
      const cfg = JSON.parse(await readFile(cfgPath, 'utf8')) as Record<string, unknown>;
      cfg.diff_fingerprint = { enabled: false, max_diff_bytes: 2_000_000 };
      await writeFile(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');
    }
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
          summary: 'cp1',
          files_changed: [],
          verification: [{ command: 'test fixture', exit_code: 0 }],
          completed_step_ids: [plan.plan_steps[0].step_id],
        })
      ),
    ]);
    return plan.artifact_id;
  }

  async function writeLooseRef(refPathSegs: string[], sha: string): Promise<void> {
    const dir = path.join(
      repo.path,
      '.git',
      'refs',
      'orcaops',
      'snap',
      ...refPathSegs.slice(0, -1)
    );
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(repo.path, '.git', 'refs', 'orcaops', 'snap', ...refPathSegs),
      sha + '\n',
      'utf8'
    );
  }

  it('stale-snapshot-refs: pass when there are no snapshot refs', async () => {
    const r = report((await doctor()).stdout);
    const c = findCheck(r, 'stale-snapshot-refs');
    expect(c.status).toBe('pass');
    expect(c.summary).toMatch(/no snapshot refs/);
  });

  it('stale-snapshot-refs: in-flight/unsynced refs are NOT flagged (no false positive)', async () => {
    // A real captured close pins open+close refs, but the artifact has
    // no summary and was never synced → must NOT be reported stale
    // (the data-loss-prevention property).
    await planOpenClose();
    const res = await doctor();
    const c = findCheck(report(res.stdout), 'stale-snapshot-refs');
    expect(c.status).toBe('pass');
    expect(res.exitCode).toBe(0);
  });

  it('stale-snapshot-refs: orphan (artifact absent) + malformed stray → warn, never fail', async () => {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo.path }).toString().trim();
    // Parseable ref whose artifact_id is absent from the cache → orphan.
    await writeLooseRef(['019e0000-0000-7000-8000-000000000000', '1', 'open'], head);
    // Wholly-malformed ref directly under the namespace → malformed.
    await writeLooseRef(['malformed-stray'], head);

    const res = await doctor();
    const r = report(res.stdout);
    const c = findCheck(r, 'stale-snapshot-refs');
    expect(c.status).toBe('warn');
    expect(c.summary).toMatch(/stale snapshot ref/);
    expect(c.details?.join('\n')).toMatch(/orphan\/malformed/);
    expect(c.details?.join('\n')).toMatch(/prune --orphans --apply/);
    // Ref leak is recoverable — overall is warn (or worse from other
    // checks) but this check never escalates to fail; warn → exit 0.
    expect(c.status).not.toBe('fail');
    expect(res.exitCode).toBe(0);
  });

  it('skipped-fingerprint-rate: pass with no closed checkpoints', async () => {
    const c = findCheck(report((await doctor()).stdout), 'skipped-fingerprint-rate');
    expect(c.status).toBe('pass');
    expect(c.summary).toMatch(/no closed checkpoints/);
  });

  it('skipped-fingerprint-rate: pass at 0% (captured cp)', async () => {
    await planOpenClose();
    const c = findCheck(report((await doctor()).stdout), 'skipped-fingerprint-rate');
    expect(c.status).toBe('pass');
    expect(c.summary).toMatch(/0\/1|1\/1|\(0%\)/);
  });

  it('skipped-fingerprint-rate: warn above 20% with reason detail', async () => {
    await planOpenClose(); // captured
    await planOpenClose({ disableFp: true }); // skipped (config-disabled)
    const c = findCheck(report((await doctor()).stdout), 'skipped-fingerprint-rate');
    expect(c.status).toBe('warn');
    expect(c.summary).toMatch(/skipped fingerprint \(50% > 20%\)/);
    expect(c.details?.join('\n')).toMatch(/deliberate skip|disabled/);
  });

  async function summarize(artifactId: string): Promise<void> {
    await agent.runRaw([
      'capture',
      'pre-pr-check',
      '--no-llm',
      '--input',
      inputFile(
        JSON.stringify({ idempotency_key: `prepr-${randomUUID()}`, artifact_id: artifactId })
      ),
    ]);
    // `capture summary` has no `--no-llm` option (only pre-pr-check does).
    await agent.runRaw([
      'capture',
      'summary',
      '--input',
      inputFile(
        JSON.stringify({
          idempotency_key: `sum-${randomUUID()}`,
          artifact_id: artifactId,
          outcome: 'done',
        })
      ),
    ]);
  }

  it('stale-snapshot-refs: flags an unmodeled pin-before-append ref on a summarized artifact', async () => {
    // Captured closed cp #1 (modeled refs .../1/{open,close}), then
    // summarize so doctor proceeds past the in-flight gate.
    const aid = await planOpenClose();
    await summarize(aid);
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo.path }).toString().trim();
    // Pin-before-append crash orphan: a parseable ref whose checkpoint
    // n=2 never committed (no checkpoint-2 projection/event).
    await writeLooseRef([aid, '2', 'open'], head);

    const res = await doctor();
    const c = findCheck(report(res.stdout), 'stale-snapshot-refs');
    expect(c.status).toBe('warn');
    const d = c.details?.join('\n') ?? '';
    expect(d).toMatch(/unmodeled .*pin-before-append/);
    expect(d).toContain(`refs/orcaops/snap/${aid}/2/open`);
    // Negative guard: the artifact's OWN modeled n=1 refs are NOT
    // listed as unmodeled (only the absent-n=2 ref is).
    expect(d).toMatch(/unmodeled.*: 1\b/);
    expect(d).not.toContain(`refs/orcaops/snap/${aid}/1/open`);
    expect(d).not.toContain(`refs/orcaops/snap/${aid}/1/close`);
    expect(d).toMatch(/prune --orphans --apply/);
    expect(c.status).not.toBe('fail');
    expect(res.exitCode).toBe(0);
  });

  /** Rot a non-tail line the way disk corruption does: valid JSON, wrong
   *  checksum — recovery-aware reads refuse the whole artifact. */
  async function rotCheckpointLine(artifactId: string): Promise<void> {
    const log = path.join(repo.path, '.orcaops', 'artifacts', artifactId, 'events.ndjson');
    const lines = (await readFile(log, 'utf8')).split('\n');
    const i = lines.findIndex((l) => l.includes('"checkpoint_closed"'));
    lines[i] = lines[i].replace(/"checksum":"[0-9a-f]{64}"/, `"checksum":"${'0'.repeat(64)}"`);
    await writeFile(log, lines.join('\n'), 'utf8');
  }

  it('stale-snapshot-refs: a rot-refused artifact is skipped with a disclosed reason (refs kept)', async () => {
    const aid = await planOpenClose();
    await summarize(aid);
    await rotCheckpointLine(aid);

    // Nothing else stale → pass, but the skip is disclosed, never silent.
    const clean = findCheck(report((await doctor()).stdout), 'stale-snapshot-refs');
    expect(clean.status).toBe('pass');
    expect(clean.summary).toMatch(/1 artifact\(s\) unreadable — refs kept/);

    // An unrelated stray drives warn: the details name the artifact and the
    // refusal, and the rot artifact's own refs are NOT counted stale.
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo.path }).toString().trim();
    await writeLooseRef(['malformed-stray'], head);
    const c = findCheck(report((await doctor()).stdout), 'stale-snapshot-refs');
    expect(c.status).toBe('warn');
    expect(c.summary).toMatch(/1 stale snapshot ref/);
    const d = c.details?.join('\n') ?? '';
    expect(d).toMatch(/1 artifact\(s\) unreadable — refs KEPT/);
    expect(d).toContain(aid);
    expect(d).toMatch(/unreadable|corrupt event-log line/);
    expect(d).not.toContain(`refs/orcaops/snap/${aid}/`);
  });

  it('a containment violation co-occurring with rot fails both ref checks instead of hiding behind the refusal', async () => {
    const aid = await planOpenClose();
    await summarize(aid);
    await rotCheckpointLine(aid);
    // Second, non-refusal fault on the SAME artifact: artifact.json becomes
    // a symlink escaping the artifacts tree — a path-guard error, which the
    // refusal must not mask (all reads settle; non-refusals rethrow to the
    // call-site guard).
    const aj = path.join(repo.path, '.orcaops', 'artifacts', aid, 'artifact.json');
    const outside = path.join(repo.path, 'outside-artifact.json');
    await writeFile(outside, '{}');
    await rm(aj);
    await symlink(outside, aj);

    const out = report((await doctor()).stdout);
    for (const name of ['stale-snapshot-refs', 'stale-baseline-refs']) {
      const c = findCheck(out, name);
      expect(c.status).toBe('fail');
      expect(c.summary).toMatch(/could not safely inspect/);
    }
    // The report survives: sibling checks still ran instead of the whole
    // command being replaced by the thrown error.
    expect(findCheck(out, 'plan-idempotency')).toBeDefined();
  });

  it('stale-baseline-refs: a rot-refused artifact is skipped with a disclosed reason (refs kept)', async () => {
    const aid = await planOpenClose();
    await summarize(aid);
    await rotCheckpointLine(aid);

    const clean = findCheck(report((await doctor()).stdout), 'stale-baseline-refs');
    expect(clean.status).toBe('pass');
    expect(clean.summary).toMatch(/1 artifact\(s\) unreadable — refs kept/);

    // A parseable baseline ref with no owning artifact drives warn.
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo.path }).toString().trim();
    const strayId = '019e0000-0000-7000-8000-000000000000';
    await mkdir(path.join(repo.path, '.git', 'refs', 'orcaops', 'baseline'), { recursive: true });
    await writeFile(
      path.join(repo.path, '.git', 'refs', 'orcaops', 'baseline', strayId),
      head + '\n',
      'utf8'
    );
    const c = findCheck(report((await doctor()).stdout), 'stale-baseline-refs');
    expect(c.status).toBe('warn');
    expect(c.summary).toMatch(/1 stale baseline ref/);
    const d = c.details?.join('\n') ?? '';
    expect(d).toMatch(/1 artifact\(s\) unreadable — refs KEPT/);
    expect(d).toContain(aid);
    expect(d).toMatch(/unreadable|corrupt event-log line/);
    expect(d).not.toContain(`refs/orcaops/baseline/${aid}`);
  });
});
