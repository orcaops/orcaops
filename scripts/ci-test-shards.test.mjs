import { execFile, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { BaseSequencer, createVitest } from 'vitest/node';
import { parse } from 'yaml';

const exec = promisify(execFile);
const repository = fileURLToPath(new URL('../', import.meta.url));
const cliRoot = path.join(repository, 'apps/orcaops-cli');
const vitest = path.join(repository, 'node_modules/vitest/vitest.mjs');
const { jobs } = parse(await readFile(path.join(repository, '.github/workflows/ci.yml'), 'utf8'));
const shards = jobs['test-cli'].strategy.matrix.shard;
const reportCheck = jobs.coverage.steps.find(
  (step) => step.name === 'Verify every CLI shard report'
).run;

describe('CI test distribution', () => {
  it('saves successful shared tests before the Watch checks can fail', () => {
    const steps = jobs.test.steps;
    const restore = steps.find((step) => step.name === 'Cache Turbo');
    const saveIndex = steps.findIndex((step) => step.name === 'Save successful test cache');
    const save = steps[saveIndex];
    expect(restore.uses).toMatch(/^actions\/cache\/restore@/);
    expect(save.uses).toMatch(/^actions\/cache\/save@/);
    expect(save.with.key).toBe(`\${{ steps.${restore.id}.outputs.cache-primary-key }}`);
    expect(save.with.path).toBe(restore.with.path);
    expect(save.if).toBe(`steps.${restore.id}.outputs.cache-hit != 'true'`);
    expect(saveIndex).toBeGreaterThan(steps.findIndex((step) => step.name === 'Test'));
    for (const command of ['test:pty', 'perf:review-cap']) {
      // Routing through Turbo is what builds each task's dependencies; a bare
      // pnpm --filter invocation runs against whatever dist already exists.
      const index = steps.findIndex(
        (step) => step.run === `pnpm exec turbo run ${command} --filter=@orcaops/watch`
      );
      expect(index).toBeGreaterThan(saveIndex);
      expect(steps[index].if).toBe('always()');
    }
  });

  it('checks out full history wherever the pinned provenance tests run', () => {
    // Those comparisons skip themselves when the pinned commit is unreachable,
    // so a shallow checkout passes while verifying nothing.
    const owners = Object.entries(jobs).filter(([, job]) =>
      (job.strategy?.matrix?.package ?? []).includes('history-convert')
    );
    expect(owners).toHaveLength(1);
    for (const [, job] of owners) {
      const checkout = job.steps.find((step) => step.uses?.startsWith('actions/checkout@'));
      expect(checkout?.with?.['fetch-depth']).toBe(0);
    }
    // The converse, which is the direction the setting actually spread: a job
    // split once copied full history into two jobs that run none of those
    // comparisons, and the comment justifying it outlived the split.
    const ownerNames = new Set(owners.map(([name]) => name));
    for (const [name, job] of Object.entries(jobs)) {
      if (ownerNames.has(name)) continue;
      const checkout = job.steps.find((step) => step.uses?.startsWith('actions/checkout@'));
      expect(checkout?.with?.['fetch-depth'], name).not.toBe(0);
    }
  });

  it('gives every simultaneous Turbo cache writer an independent namespace', () => {
    const keys = [];
    for (const [name, job] of Object.entries(jobs)) {
      const cache = job.steps.find((step) => step.name === 'Cache Turbo');
      if (!cache) continue;
      const matrix = job.strategy?.matrix ?? { single: [''] };
      const [[axis, values]] = Object.entries(matrix);
      for (const value of values) {
        const expand = (text) =>
          text
            .replaceAll('${{ github.job }}', name)
            .replaceAll(`\${{ matrix.${axis} }}`, String(value));
        const key = expand(cache.with.key);
        keys.push(key);
        for (const prefix of expand(cache.with['restore-keys']).trim().split('\n')) {
          expect(key.startsWith(prefix)).toBe(true);
        }
      }
    }
    expect(keys).toHaveLength(15);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('runs shared packages once and keeps every test result in the required gate', () => {
    const shared = jobs.test.steps.find((step) => step.name === 'Test').run;
    for (const pkg of ['cli', ...jobs['test-heavy'].strategy.matrix.package]) {
      expect(shared).toContain(`--exclude=@orcaops/${pkg}`);
    }
    expect(shared).not.toContain('--only=');
    expect(jobs['test-heavy'].steps.find((step) => step.name === 'Test package').run).toBe(
      'pnpm test --only=@orcaops/${{ matrix.package }}'
    );
    expect(jobs['test-cli'].needs).toBeUndefined();
    expect(jobs['test-cli'].strategy['fail-fast']).toBe(false);
    expect(
      jobs['test-cli'].steps.find((step) => step.name === 'CLI tests with coverage').run
    ).toContain(`--shard=\${{ matrix.shard }}/${shards.length}`);
    expect(
      jobs['test-cli'].steps.find((step) => step.name === 'Upload test and coverage report').with
        .path
    ).toBe(`apps/orcaops-cli/.vitest-reports/blob-\${{ matrix.shard }}-${shards.length}.json`);
    expect(jobs.coverage.needs).toBe('test-cli');
    expect(jobs.check.needs).toEqual(
      expect.arrayContaining(['test', 'test-heavy', 'test-cli', 'coverage'])
    );
    expect(jobs.check.if).toBe('always()');
    const gate = jobs.check.steps[0];
    const env = Object.fromEntries(Object.keys(gate.env).map((key) => [key, 'success']));
    const run = (overrides = {}) =>
      spawnSync('bash', ['-c', gate.run], { env: { ...process.env, ...env, ...overrides } }).status;
    expect(run()).toBe(0);
    for (const name of Object.keys(env)) {
      for (const status of ['failure', 'cancelled', 'skipped'])
        expect(run({ [name]: status })).toBe(1);
    }
  });

  it('rejects any missing or empty shard report before merging', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'orcaops-report-check-'));
    try {
      const directory = path.join(root, 'apps/orcaops-cli/.vitest-reports');
      await mkdir(directory, { recursive: true });
      const files = shards.map((index) =>
        path.join(directory, `blob-${index}-${shards.length}.json`)
      );
      for (const file of files) await writeFile(file, 'report');
      const check = () => spawnSync('bash', ['-c', reportCheck], { cwd: root }).status;
      expect(check()).toBe(0);
      for (const file of files) {
        await rm(file);
        expect(check()).not.toBe(0);
        await writeFile(file, '');
        expect(check()).not.toBe(0);
        await writeFile(file, 'report');
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('partitions every CLI project without changing its isolation or coverage contract', async () => {
    const contexts = [];
    try {
      for (const config of ['vitest.config.ts', 'vitest.shard.config.ts']) {
        contexts.push(
          await createVitest('test', {
            root: cliRoot,
            config: path.join(cliRoot, config),
            watch: false,
          })
        );
      }
      const [normal, sharded] = contexts;
      const key = (spec) => `${spec.project.name}:${spec.moduleId}`;
      const all = await normal.globTestSpecifications();
      const candidates = await sharded.globTestSpecifications();
      expect(all.length).toBeGreaterThan(300);
      expect(candidates.map(key).sort()).toEqual(all.map(key).sort());
      const selected = [];
      for (const index of shards) {
        sharded.config.shard = { index, count: shards.length };
        const group = await new BaseSequencer(sharded).shard(candidates);
        expect(group.length).toBeGreaterThan(0);
        selected.push(...group.map(key));
      }
      expect(new Set(selected).size).toBe(all.length);
      expect(selected.sort()).toEqual(all.map(key).sort());
      expect(sharded.config.coverage.thresholds).toBeUndefined();
      expect(normal.config.coverage.thresholds).toMatchObject({
        lines: 85.59,
        statements: 84.38,
        functions: 88.04,
        branches: 75.85,
      });
      for (const project of sharded.projects) {
        expect(project.config.pool).toBe('forks');
        if (project.name === 'packaged') {
          expect(project.config.maxWorkers).toBe(1);
          expect(project.config.fileParallelism).toBe(false);
        }
      }
    } finally {
      await Promise.all(contexts.map((context) => context.close()));
    }
  }, 30_000);

  it('merges real blob coverage and rejects an incomplete coverage result', async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'orcaops-coverage-merge-')));
    try {
      const subject = shards
        .map((index) => `export function value${index}() { return ${index}; }`)
        .join('\n');
      await writeFile(path.join(root, 'subject.ts'), subject);
      for (const index of shards) {
        await writeFile(
          path.join(root, `value${index}.test.ts`),
          `import { expect, test } from ${JSON.stringify(path.join(repository, 'node_modules/vitest/dist/index.js'))};\nimport { value${index} } from './subject';\ntest('returns its value', () => expect(value${index}()).toBe(${index}));\n`
        );
      }
      for (const [name, source] of [
        ['shard', 'vitest.shard.config.ts'],
        ['merge', 'vitest.config.ts'],
      ]) {
        await writeFile(
          path.join(root, `${name}.config.mjs`),
          `import config from ${JSON.stringify(path.join(cliRoot, source))};\nexport default { test: { root: ${JSON.stringify(root)}, include: ['*.test.ts'], maxWorkers: 1, coverage: { ...config.test.coverage, include: ['subject.ts'], reporter: ['json-summary'] } } };\n`
        );
      }
      const run = async (...args) => {
        try {
          return await exec(process.execPath, [vitest, ...args], { cwd: root, timeout: 30_000 });
        } catch (error) {
          error.message += `\n${error.stdout}`;
          throw error;
        }
      };
      for (const index of shards)
        await run(
          'run',
          '--config=shard.config.mjs',
          '--coverage',
          `--shard=${index}/${shards.length}`,
          '--reporter=blob'
        );
      await run('--config=merge.config.mjs', '--merge-reports', '--coverage');
      const coverage = JSON.parse(
        await readFile(path.join(root, 'coverage/coverage-summary.json'), 'utf8')
      );
      expect(coverage.total.lines.pct).toBe(100);
      expect(coverage.total.functions.pct).toBe(100);
      await rm(path.join(root, `.vitest-reports/blob-1-${shards.length}.json`));
      await expect(
        run('--config=merge.config.mjs', '--merge-reports', '--coverage')
      ).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('threshold') });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 90_000);
});
