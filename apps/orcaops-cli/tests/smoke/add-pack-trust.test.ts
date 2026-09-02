import { spawn } from 'node:child_process';
import { cp, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

import { createTempRepo, type TempRepo } from '@orcaops/test-harness';

import { readGrants } from '../../src/lib/evaluator-grants.js';

/**
 * Interactive trust prompt smoke tests.
 *
 * InProcessAgent rejects stdin (see in-process-agent.ts), so
 * the Y/N prompt paths can only run against a spawned subprocess.
 * The companion `tests/integration/add-pack-trust.test.ts` covers the 4 non-
 * interactive cases (--yes, JSON-without-yes, LLM-only, --force).
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// tests/smoke/add-pack-trust.test.ts → ../../bin/orcaops.js
const BIN = path.resolve(__dirname, '..', '..', 'bin', 'orcaops.js');
const TEST_PACK = path.resolve(__dirname, '..', 'fixtures', 'test-pack');

interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function runOrcaops(
  args: string[],
  opts: { cwd: string; stdin: string }
): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      cwd: opts.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString('utf8');
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ stdout, stderr, exitCode: code ?? 0 }));
    child.stdin.write(opts.stdin);
    child.stdin.end();
  });
}

interface YamlPackEntry {
  id: string;
  source: { kind: string };
}
interface YamlConfig {
  schema: string;
  packages: YamlPackEntry[];
  evaluators: Record<string, unknown>;
}

async function readYaml(repoRoot: string): Promise<YamlConfig> {
  const raw = await readFile(path.join(repoRoot, '.orcaops', 'evaluators.yaml'), 'utf8');
  return parseYaml(raw) as YamlConfig;
}

describe('orcaops eval add-pack — interactive prompt (smoke)', () => {
  let repo: TempRepo;
  let tmpRoot: string;

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
    // Init the repo via the CLI so .orcaops/config.json + cache db
    // exist before we exercise add-pack.
    await runOrcaops(['init', '--no-llm', '--json'], { cwd: repo.path, stdin: '' });
    tmpRoot = await mkdtemp(path.join(tmpdir(), 'orcaops-trust-smoke-'));
  });

  afterEach(async () => {
    await repo.cleanup();
    await rm(tmpRoot, { recursive: true, force: true });
  });

  async function freshTestPack(): Promise<string> {
    const packPath = path.join(tmpRoot, `pack-${Math.random().toString(36).slice(2)}`);
    await cp(TEST_PACK, packPath, { recursive: true });
    return packPath;
  }

  it('interactive Y persists a USER-LOCAL grant (never a yaml block)', async () => {
    const packPath = await freshTestPack();
    const r = await runOrcaops(['eval', 'add-pack', packPath], {
      cwd: repo.path,
      stdin: 'y\n',
    });
    expect(r.exitCode).toBe(0);
    // The spawned CLI inherits this worker's hermetic ORCAOPS_CONFIG_HOME,
    // so the grant it wrote is visible to readGrants() here.
    const grant = readGrants({ repoRoot: repo.path }).grants.find(
      (g) => g.package_id === 'test-pack'
    );
    expect(grant?.kind).toBe('fingerprint');
    expect(grant?.capabilities).toEqual(['command_evaluators_present']);
    if (grant?.kind === 'fingerprint') {
      expect(grant.source_fingerprint).toMatch(/^[0-9a-f]{64}$/);
    }
    const yaml = await readYaml(repo.path);
    expect(yaml.packages.find((p) => p.id === 'test-pack')).not.toHaveProperty('trusted');
  }, 15_000);

  it('the consent prompt for a mixed pack names every capability class', async () => {
    // A pack with a command evaluator AND a file-reading llm evaluator: the
    // prompt must present every class the grant will carry — showing only
    // the command wording understates what consent authorizes.
    const packPath = await freshTestPack();
    const { mkdir, writeFile } = await import('node:fs/promises');
    await mkdir(path.join(packPath, 'prompts'), { recursive: true });
    await writeFile(path.join(packPath, 'prompts', 'read.md'), 'Read files.\n', 'utf8');
    await writeFile(
      path.join(packPath, 'evaluators', 'reader.eval.yaml'),
      [
        'schema: orcaops.evaluator/v1',
        'id: reader',
        'phase: pre-pr',
        'severity: warn',
        'description: reads repo files',
        'engine:',
        '  kind: llm',
        '  additional_context_sections: []',
        '  prompt_file: ./prompts/read.md',
        '  output_format: markdown',
        '  timeout_ms: 120000',
        '  tool_policy:',
        '    mode: command-filtered',
        'filters:',
        '  when_llm: required',
      ].join('\n'),
      'utf8'
    );
    const r = await runOrcaops(['eval', 'add-pack', packPath], {
      cwd: repo.path,
      stdin: 'n\n',
    });
    expect(r.stderr).toContain('command_evaluators_present');
    expect(r.stderr).toContain('llm_evaluators_present');
    expect(r.stderr).toContain('file_reading_llm_evaluator_present');
    expect(r.exitCode).toBe(1);
  }, 15_000);

  it('interactive N aborts and writes no pack entry', async () => {
    const packPath = await freshTestPack();
    const r = await runOrcaops(['eval', 'add-pack', packPath], {
      cwd: repo.path,
      stdin: 'n\n',
    });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/Aborted/i);
    // The yaml may or may not exist at this point. If it does, the
    // pack must not be registered (the trust prompt aborted before
    // writeEvaluatorsConfig).
    const yamlPath = path.join(repo.path, '.orcaops', 'evaluators.yaml');
    try {
      const yaml = await readYaml(repo.path);
      const entry = yaml.packages.find((p) => p.id === 'test-pack');
      expect(entry).toBeUndefined();
    } catch (err) {
      // ENOENT — yaml never created. Acceptable.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new Error(`unexpected error reading ${yamlPath}: ${(err as Error).message}`);
      }
    }
  }, 15_000);

  it('eval trust accepts y and yes, and EOF declines without hanging', async () => {
    const packPath = await freshTestPack();
    const registered = await runOrcaops(['eval', 'add-pack', packPath, '--yes', '--json'], {
      cwd: repo.path,
      stdin: '',
    });
    expect(registered.exitCode).toBe(0);

    for (const answer of ['y\n', 'yes\n']) {
      const revoked = await runOrcaops(['eval', 'trust', 'test-pack', '--revoke', '--json'], {
        cwd: repo.path,
        stdin: '',
      });
      expect(revoked.exitCode).toBe(0);
      const accepted = await runOrcaops(['eval', 'trust', 'test-pack'], {
        cwd: repo.path,
        stdin: answer,
      });
      expect(accepted.exitCode).toBe(0);
      expect(readGrants({ repoRoot: repo.path }).grants).toHaveLength(1);
    }

    await runOrcaops(['eval', 'trust', 'test-pack', '--revoke', '--json'], {
      cwd: repo.path,
      stdin: '',
    });
    const declined = await runOrcaops(['eval', 'trust', 'test-pack'], {
      cwd: repo.path,
      stdin: '',
    });
    expect(declined.exitCode).toBe(1);
    expect(declined.stderr).toMatch(/Aborted: trust not granted/);
    expect(readGrants({ repoRoot: repo.path }).grants).toEqual([]);
  }, 30_000);

  it('neutralizes controls in add-pack and workspace trust success output', async () => {
    const original = await freshTestPack();
    const esc = String.fromCharCode(0x1b);
    const bidi = '\u202e';
    const packPath = path.join(tmpRoot, `pack-${esc}[2J${bidi}hidden`);
    await rename(original, packPath);

    const added = await runOrcaops(['eval', 'add-pack', packPath, '--yes'], {
      cwd: repo.path,
      stdin: '',
    });
    expect(added.exitCode).toBe(0);
    expect(added.stdout).not.toContain(esc);
    expect(added.stdout).not.toContain(bidi);

    await runOrcaops(['eval', 'trust', 'test-pack', '--revoke', '--json'], {
      cwd: repo.path,
      stdin: '',
    });
    const trusted = await runOrcaops(['eval', 'trust', 'test-pack', '--dev', '--yes'], {
      cwd: repo.path,
      stdin: '',
    });
    expect(trusted.exitCode).toBe(0);
    expect(trusted.stdout).not.toContain(esc);
    expect(trusted.stdout).not.toContain(bidi);
    expect(trusted.stdout).not.toContain('[2J');
    expect(trusted.stdout).toContain('pack-hidden');
  }, 30_000);

  it('eval show neutralizes terminal controls in pre-consent pack text', async () => {
    const packPath = await freshTestPack();
    const specPath = path.join(packPath, 'evaluators', 'api-stub.eval.yaml');
    const esc = String.fromCharCode(0x1b);
    const bel = String.fromCharCode(0x07);
    const csi = String.fromCharCode(0x9b);
    const bidi = '\u202e';
    await writeFile(
      specPath,
      (await readFile(specPath, 'utf8')) +
        `\n# before${esc}[8;1Hhidden${esc}]52;c;cG9pc29u${bel}${csi}2Jafter${bidi}override\n`,
      'utf8'
    );
    const registered = await runOrcaops(['eval', 'add-pack', packPath, '--yes', '--json'], {
      cwd: repo.path,
      stdin: '',
    });
    expect(registered.exitCode).toBe(0);
    const revoked = await runOrcaops(['eval', 'trust', 'test-pack', '--revoke', '--json'], {
      cwd: repo.path,
      stdin: '',
    });
    expect(revoked.exitCode).toBe(0);
    expect(readGrants({ repoRoot: repo.path }).grants).toEqual([]);

    const shown = await runOrcaops(['eval', 'show', 'test-pack/api-stub'], {
      cwd: repo.path,
      stdin: '',
    });

    expect(shown.exitCode).toBe(0);
    expect(shown.stdout).toContain('before');
    expect(shown.stdout).toContain('hidden');
    expect(shown.stdout).toContain('after');
    expect(shown.stdout).not.toContain(bidi);
    expect(
      [...shown.stdout].some((char) => {
        const code = char.charCodeAt(0);
        return code <= 0x08 || (code >= 0x0b && code <= 0x1f) || (code >= 0x7f && code <= 0x9f);
      })
    ).toBe(false);
  }, 30_000);
});
