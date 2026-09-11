import { createHash } from 'node:crypto';
import { access, chmod, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { canonicalJson, CONFIG_SCHEMA_VERSION, uuidv7 } from '@orcaops/storage';
import { createTempRepo, inputFile } from '@orcaops/test-harness';

import { fixture, inventory } from '../helpers/database-history.js';
import { makeAgent } from '../support/test-agent.js';

const repairSeed = vi.hoisted(() => vi.fn(async () => ({})));

vi.mock('../../src/commands/seed/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/commands/seed/index.js')>();
  return { ...actual, repairSeed };
});

interface DoctorReport {
  overall: 'pass' | 'warn' | 'fail';
  checks: Array<{ name: string; status: 'pass' | 'warn' | 'fail'; summary: string }>;
}

function check(report: DoctorReport, name: string) {
  const value = report.checks.find((entry) => entry.name === name);
  if (!value) throw new Error(`Missing doctor check ${name}`);
  return value;
}

describe('database doctor command', () => {
  it('refuses invalid init options before history setup', async () => {
    const repo = await createTempRepo({ initialBranch: 'main' });
    try {
      const dataRoot = path.join(repo.path, '.history-data');
      const result = await makeAgent({
        cwd: repo.path,
        env: { ORCAOPS_DATA_DIR: dataRoot, ORCAOPS_DISABLE_DRAIN: '1' },
      }).runRaw(['init', '--reset-config', '--no-llm', '--json']);

      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.stdout).error.code).toBe('INVALID_INPUT');
      await expect(access(dataRoot)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(access(path.join(repo.path, '.orcaops'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      await repo.cleanup();
    }
  });

  it('refuses invalid init configuration before history setup', async () => {
    const repo = await createTempRepo({ initialBranch: 'main' });
    try {
      const dataRoot = path.join(repo.path, '.history-data');
      const configPath = path.join(repo.path, '.orcaops', 'config.json');
      const config = JSON.stringify({
        schema_version: CONFIG_SCHEMA_VERSION,
        unexpected_setting: true,
      });
      await mkdir(path.dirname(configPath), { recursive: true });
      await writeFile(configPath, config, 'utf8');
      const result = await makeAgent({
        cwd: repo.path,
        env: { ORCAOPS_DATA_DIR: dataRoot, ORCAOPS_DISABLE_DRAIN: '1' },
      }).runRaw(['init', '--force', '--no-llm', '--json']);

      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.stdout).error.code).toBe('INVALID_CONFIG');
      expect(await readFile(configPath, 'utf8')).toBe(config);
      await expect(access(dataRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await repo.cleanup();
    }
  });

  it('refuses a secret setup path before history or installer writes', async () => {
    const repo = await createTempRepo({ initialBranch: 'main' });
    try {
      const credentialShaped = `${'ghp'}_${'A1b2C3d4E5f6G7h8'.repeat(2)}abcd`;
      const dataRoot = path.join(repo.path, credentialShaped);
      const gitConfigPath = path.join(repo.path, '.git', 'config');
      const configBefore = await readFile(gitConfigPath, 'utf8');
      const result = await makeAgent({
        cwd: repo.path,
        env: { ORCAOPS_DATA_DIR: dataRoot, ORCAOPS_DISABLE_DRAIN: '1' },
      }).runRaw(['init', '--scope', 'project', '--no-llm', '--json']);

      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.stdout).error.code).toBe('SECRET_IN_PAYLOAD');
      expect(result.stdout + result.stderr).not.toContain(credentialShaped);
      expect(await readFile(gitConfigPath, 'utf8')).toBe(configBefore);
      await expect(access(dataRoot)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(access(path.join(repo.path, '.orcaops'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      await repo.cleanup();
    }
  });

  it('registers fresh init history that Doctor and the first capture reuse', async () => {
    const repo = await createTempRepo({ initialBranch: 'main' });
    try {
      const dataRoot = path.join(repo.path, '.history-data');
      const agent = makeAgent({
        cwd: repo.path,
        env: {
          CLAUDE_SESSION_ID: 'database-doctor-init',
          ORCAOPS_CLOUD_FEATURES: '0',
          ORCAOPS_DATA_DIR: dataRoot,
          ORCAOPS_DISABLE_DRAIN: '1',
        },
      });
      const initialized = await agent.runRaw(['init', '--scope', 'project', '--no-llm', '--json']);
      expect(initialized.exitCode, initialized.stdout + initialized.stderr).toBe(0);
      const initBody = JSON.parse(initialized.stdout) as { project_id: string };
      const registrationPath = path.join(repo.path, '.git', 'orcaops', 'registration.json');
      const registration = await readFile(registrationPath, 'utf8');
      expect(JSON.parse(registration).authority.project_id).toBe(initBody.project_id);

      const before = await inventory(repo.path);
      const diagnosed = await agent.runRaw(['doctor', '--json']);
      const report = JSON.parse(diagnosed.stdout) as DoctorReport;
      expect(diagnosed.exitCode, diagnosed.stdout + diagnosed.stderr).toBe(0);
      expect(check(report, 'history-database').status).toBe('pass');
      expect(check(report, 'artifact-integrity').status).toBe('pass');
      expect(await inventory(repo.path)).toEqual(before);

      const captured = await agent.runRaw([
        'capture',
        'plan',
        '--no-llm',
        '--input',
        inputFile(
          JSON.stringify({
            task: 'Reuse initialized history',
            label: 'Reuse initialized history',
            plan_steps: [{ text: 'Record one plan', label: 'Record plan' }],
            touched_scope: [],
            non_goals: [],
          })
        ),
      ]);
      expect(captured.exitCode, captured.stdout + captured.stderr).toBe(0);
      expect(await readFile(registrationPath, 'utf8')).toBe(registration);
      expect(
        (await readdir(path.join(dataRoot, 'projects'))).filter((entry) => entry !== 'catalog')
      ).toEqual([initBody.project_id]);
    } finally {
      await repo.cleanup();
    }
  });

  it('reads the registered database without changing retained application state', async () => {
    const f = await fixture();
    await f.capture();
    const agent = makeAgent({
      cwd: f.main,
      env: {
        CLAUDE_SESSION_ID: 'database-doctor',
        ORCAOPS_CLOUD_FEATURES: '0',
        ORCAOPS_DATA_DIR: f.root,
        ORCAOPS_DISABLE_DRAIN: '1',
      },
    });
    const registrationPath = path.join(f.main, '.git', 'orcaops', 'registration.json');
    const registration = await readFile(registrationPath, 'utf8');
    const initialized = await agent.runRaw(['init', '--scope', 'project', '--no-llm', '--json']);
    expect(initialized.exitCode, initialized.stdout + initialized.stderr).toBe(0);
    expect(JSON.parse(initialized.stdout).project_id).toBe(f.authority.projectId);
    expect(await readFile(registrationPath, 'utf8')).toBe(registration);
    expect(
      (await readdir(path.join(f.root, 'projects'))).filter((entry) => entry !== 'catalog')
    ).toEqual([f.authority.projectId]);
    const before = await inventory(f.temporary);

    const result = await agent.runRaw(['doctor', '--json']);
    const report = JSON.parse(result.stdout) as DoctorReport;

    expect(result.exitCode).toBe(0);
    expect(check(report, 'history-database').status).toBe('pass');
    expect(check(report, 'artifact-integrity').status).toBe('pass');
    expect(check(report, 'git-publications').status).toBe('pass');
    expect(report.checks.some((entry) => entry.name === 'cache')).toBe(false);
    expect(report.checks.some((entry) => entry.name === 'archive')).toBe(false);
    expect(await inventory(f.temporary)).toEqual(before);
  });

  it('reads registered history when installer configuration is missing', async () => {
    const f = await fixture();
    await f.capture();
    const agent = makeAgent({
      cwd: f.main,
      env: {
        CLAUDE_SESSION_ID: 'database-doctor-no-config',
        ORCAOPS_CLOUD_FEATURES: '0',
        ORCAOPS_DATA_DIR: f.root,
        ORCAOPS_DISABLE_DRAIN: '1',
      },
    });
    const before = await inventory(f.temporary);

    const result = await agent.runRaw(['doctor', '--json']);
    const report = JSON.parse(result.stdout) as DoctorReport;

    expect(result.exitCode).toBe(1);
    expect(check(report, 'config')).toMatchObject({ status: 'fail' });
    expect(check(report, 'history-database')).toMatchObject({ status: 'pass' });
    expect(check(report, 'artifact-integrity')).toMatchObject({ status: 'pass' });
    expect(await inventory(f.temporary)).toEqual(before);
  });

  it('reports missing registration without minting history during diagnosis or preview', async () => {
    const repo = await createTempRepo({ initialBranch: 'main' });
    try {
      const dataRoot = path.join(repo.path, '.history-data');
      const agent = makeAgent({
        cwd: repo.path,
        env: {
          CLAUDE_SESSION_ID: 'database-doctor-missing',
          ORCAOPS_CLOUD_FEATURES: '0',
          ORCAOPS_CONFIG_HOME: path.join(repo.path, '.config-home'),
          ORCAOPS_DATA_DIR: dataRoot,
          ORCAOPS_DISABLE_DRAIN: '1',
        },
      });
      const preview = await agent.runRaw([
        'init',
        '--scope',
        'project',
        '--dry-run',
        '--no-llm',
        '--json',
      ]);
      expect(preview.exitCode, preview.stdout + preview.stderr).toBe(0);
      await expect(access(dataRoot)).rejects.toMatchObject({ code: 'ENOENT' });
      const before = await inventory(repo.path);
      repairSeed.mockClear();

      for (const args of [
        ['doctor', '--json'],
        ['doctor', '--fix', '--dry-run', '--json'],
      ]) {
        const result = await agent.runRaw(args);
        const report = JSON.parse(result.stdout) as DoctorReport;
        expect(result.exitCode).toBe(1);
        expect(check(report, 'history-database')).toMatchObject({
          status: 'fail',
        });
        expect(check(report, 'history-database').summary).toContain('HISTORY_MISSING');
      }

      await expect(access(dataRoot)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(repairSeed).not.toHaveBeenCalled();
      expect(await inventory(repo.path)).toEqual(before);
    } finally {
      await repo.cleanup();
    }
  });

  it('preserves legacy history presence instead of initializing a replacement', async () => {
    const repo = await createTempRepo({ initialBranch: 'main' });
    try {
      const dataRoot = path.join(repo.path, '.history-data');
      const legacyArtifact = path.join(repo.path, '.orcaops', 'artifacts', 'retained.json');
      await mkdir(path.dirname(legacyArtifact), { recursive: true });
      await writeFile(legacyArtifact, 'retained history\n', 'utf8');
      const before = await inventory(repo.path);
      const result = await makeAgent({
        cwd: repo.path,
        env: { ORCAOPS_DATA_DIR: dataRoot, ORCAOPS_DISABLE_DRAIN: '1' },
      }).runRaw(['init', '--scope', 'project', '--no-llm', '--json']);
      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.stdout).error.code).toBe('CONVERSION_REQUIRED');
      await expect(access(dataRoot)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await inventory(repo.path)).toEqual(before);
    } finally {
      await repo.cleanup();
    }
  });

  it('does not delegate seed repair during a registered dry-run preview', async () => {
    const f = await fixture();
    const agent = makeAgent({
      cwd: f.main,
      env: {
        CLAUDE_SESSION_ID: 'database-doctor-preview',
        ORCAOPS_CLOUD_FEATURES: '0',
        ORCAOPS_DATA_DIR: f.root,
        ORCAOPS_DISABLE_DRAIN: '1',
      },
    });
    expect((await agent.runRaw(['init', '--scope', 'project', '--no-llm'])).exitCode).toBe(0);
    repairSeed.mockClear();
    const before = await inventory(f.temporary);

    const result = await agent.runRaw(['doctor', '--fix', '--dry-run', '--json']);
    const report = JSON.parse(result.stdout) as DoctorReport;

    expect(result.exitCode).toBe(0);
    expect(repairSeed).not.toHaveBeenCalled();
    expect(check(report, 'fix').summary).toContain('would run `orcaops seed --yes`');
    expect(await inventory(f.temporary)).toEqual(before);
  });

  it('preserves wrong store-instance classification from registered authority', async () => {
    const f = await fixture();
    const registrationPath = path.join(f.main, '.git', 'orcaops', 'registration.json');
    const registration = JSON.parse(await readFile(registrationPath, 'utf8')) as {
      hash: string;
      authority: { store_instance_id: string };
      [key: string]: unknown;
    };
    const body = structuredClone(registration);
    Reflect.deleteProperty(body, 'hash');
    body.authority.store_instance_id = uuidv7();
    await writeFile(
      registrationPath,
      `${canonicalJson({
        ...body,
        hash: createHash('sha256').update(canonicalJson(body)).digest('hex'),
      })}\n`,
      'utf8'
    );
    const agent = makeAgent({
      cwd: f.main,
      env: {
        CLAUDE_SESSION_ID: 'database-doctor-wrong-instance',
        ORCAOPS_CLOUD_FEATURES: '0',
        ORCAOPS_DATA_DIR: f.root,
        ORCAOPS_DISABLE_DRAIN: '1',
      },
    });
    const before = await inventory(f.temporary);
    const initialized = await agent.runRaw(['init', '--scope', 'project', '--no-llm', '--json']);
    expect(initialized.exitCode).toBe(1);
    expect(JSON.parse(initialized.stdout).error.code).toBe('HISTORY_MISSING');
    expect(await inventory(f.temporary)).toEqual(before);

    const result = await agent.runRaw(['doctor', '--json']);
    const report = JSON.parse(result.stdout) as DoctorReport;

    expect(result.exitCode).toBe(1);
    expect(check(report, 'history-database').summary).toContain('HISTORY_MISSING');
    expect(check(report, 'history-database').summary).toContain('store instance');
  });

  it('classifies an unreadable registered database as inaccessible', async () => {
    const f = await fixture();
    const agent = makeAgent({
      cwd: f.main,
      env: {
        CLAUDE_SESSION_ID: 'database-doctor-inaccessible',
        ORCAOPS_CLOUD_FEATURES: '0',
        ORCAOPS_DATA_DIR: f.root,
        ORCAOPS_DISABLE_DRAIN: '1',
      },
    });
    await chmod(f.writer.databasePath, 0o000);
    try {
      const result = await agent.runRaw(['doctor', '--json']);
      const report = JSON.parse(result.stdout) as DoctorReport;

      expect(result.exitCode).toBe(1);
      expect(check(report, 'history-database').summary).toContain('HISTORY_INACCESSIBLE');
    } finally {
      await chmod(f.writer.databasePath, 0o600);
    }
  });

  it('delegates an authorized seed repair without changing retained history itself', async () => {
    const f = await fixture();
    const agent = makeAgent({
      cwd: f.main,
      env: {
        CLAUDE_SESSION_ID: 'database-doctor-fix',
        ORCAOPS_CLOUD_FEATURES: '0',
        ORCAOPS_DATA_DIR: f.root,
        ORCAOPS_DISABLE_DRAIN: '1',
      },
    });
    expect((await agent.runRaw(['init', '--scope', 'project', '--no-llm'])).exitCode).toBe(0);
    repairSeed.mockClear();
    const before = await inventory(f.temporary);

    const result = await agent.runRaw(['doctor', '--fix', '--json']);
    const report = JSON.parse(result.stdout) as DoctorReport;

    expect(result.exitCode).toBe(0);
    expect(repairSeed).toHaveBeenCalledOnce();
    expect(repairSeed).toHaveBeenCalledWith(f.main);
    expect(check(report, 'fix').summary).toContain('resumed `orcaops seed --yes`');
    expect(await inventory(f.temporary)).toEqual(before);
  });
});
