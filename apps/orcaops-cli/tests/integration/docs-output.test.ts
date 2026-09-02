import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createHistoryRepo,
  createTempRepo,
  type HistoryRepo,
  type TempRepo,
} from '@orcaops/test-harness';

import { makeAgent } from '../support/test-agent.js';

vi.mock('@clack/prompts', () => ({
  cancel: vi.fn(),
  isCancel: () => false,
  multiselect: vi.fn(async () => ['claude-code']),
  select: vi.fn(async ({ initialValue }: { initialValue?: unknown }) => initialValue),
  confirm: vi.fn(async ({ message, initialValue }: { message: string; initialValue?: boolean }) =>
    message.startsWith('Continue with') ? true : initialValue
  ),
  text: vi.fn(async ({ initialValue }: { initialValue?: string }) => initialValue ?? 'orcaops'),
}));

const testDir = path.dirname(fileURLToPath(import.meta.url));
const docsRoot = path.resolve(testDir, '../../../docs/content');

/**
 * Git renders a UTC offset as `Z` from 2.5x onward and as `+00:00` before it,
 * so one fixture prints two ways depending on the developer's git. Canonicalize
 * both sides instead of pinning the documented output to a single git version —
 * the same reasoning as the deterministic-timestamp normalization in
 * `packages/test-harness/src/temp-repo.test.ts`.
 */
function normalizeUtcOffset(text: string): string {
  return text.replaceAll(/(\d{2}:\d{2}:\d{2})\+00:00/gu, '$1Z');
}

async function documentedOutput(file: string, id: string): Promise<string> {
  const content = await readFile(path.join(docsRoot, file), 'utf8');
  const start = `<!-- cli-output:${id}:start -->`;
  const end = `<!-- cli-output:${id}:end -->`;
  const marked = content.slice(content.indexOf(start) + start.length, content.indexOf(end));
  const output = /^\s*```text\n([\s\S]*?)\n```\s*$/u.exec(marked)?.[1];
  if (output === undefined) throw new Error(`Missing documented CLI output ${id} in ${file}`);
  return normalizeUtcOffset(output);
}

async function normalizePaths(output: string, repoPath: string): Promise<string> {
  const canonicalRepoPath = await realpath(repoPath);
  return normalizeUtcOffset(
    output.replaceAll(canonicalRepoPath, '<repo>').replaceAll(repoPath, '<repo>').trimEnd()
  );
}

function expectOrderedExcerpt(actual: string, excerpt: string): void {
  let cursor = 0;
  for (const segment of excerpt.split('\n…\n')) {
    const at = actual.indexOf(segment, cursor);
    expect(
      at,
      `missing documented output segment:\n${segment}\n\nactual output:\n${actual}`
    ).toBeGreaterThanOrEqual(cursor);
    cursor = at + segment.length;
  }
}

describe('documented CLI output', () => {
  let repos: TempRepo[] = [];
  let tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(repos.map((repo) => repo.cleanup()));
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    repos = [];
    tempDirs = [];
  });

  it('keeps the initialization summary tied to the interactive personal default', async () => {
    const repo = await createTempRepo({ initialBranch: 'main' });
    repos.push(repo);
    const homeRoot = await mkdtemp(path.join(tmpdir(), 'orcaops-docs-home-'));
    const binRoot = await mkdtemp(path.join(tmpdir(), 'orcaops-docs-bin-'));
    tempDirs.push(homeRoot, binRoot);
    const claudePath = path.join(binRoot, 'claude');
    await writeFile(claudePath, '#!/bin/sh\nexit 0\n', 'utf8');
    await chmod(claudePath, 0o755);
    const agent = makeAgent({
      cwd: repo.path,
      env: {
        ORCAOPS_DISABLE_DRAIN: '1',
        ORCAOPS_DATA_DIR: path.join(homeRoot, 'data'),
        ORCAOPS_GLOBAL_ROOT: path.join(homeRoot, 'global'),
        CLAUDE_CONFIG_DIR: path.join(homeRoot, 'claude'),
        CODEX_HOME: path.join(homeRoot, 'codex'),
        PATH: `${binRoot}:/usr/bin:/bin`,
      },
    });

    const hadStdoutTty = process.stdout.isTTY;
    const hadStdinTty = process.stdin.isTTY;
    const hadCi = process.env.CI;
    (process.stdout as unknown as { isTTY: boolean }).isTTY = true;
    (process.stdin as unknown as { isTTY: boolean }).isTTY = true;
    delete process.env.CI;

    const result = await (async () => {
      try {
        return await agent.runRaw(['init']);
      } finally {
        (process.stdout as unknown as { isTTY: boolean | undefined }).isTTY = hadStdoutTty;
        (process.stdin as unknown as { isTTY: boolean | undefined }).isTTY = hadStdinTty;
        if (hadCi === undefined) delete process.env.CI;
        else process.env.CI = hadCi;
      }
    })();
    expect(result.exitCode).toBe(0);

    const normalized = (await normalizePaths(result.stdout, repo.path)).replaceAll(
      path.join(homeRoot, 'global', 'claude-code', 'skills'),
      '<agent-skills-dir>'
    );
    expectOrderedExcerpt(normalized, await documentedOutput('getting-started.md', 'init-summary'));
  });

  it('keeps seed, evaluator, and doctor examples tied to one deterministic repository', async () => {
    const repo: HistoryRepo = await createHistoryRepo([
      {
        type: 'commit',
        label: 'root',
        subject: 'feat: establish activity service',
        authorDate: '2025-01-01T00:00:00Z',
        committerDate: '2025-01-01T00:00:00Z',
        files: { 'README.md': '# Activity service\n' },
      },
      {
        type: 'commit',
        label: 'pagination',
        subject: 'feat: paginate the activity feed',
        authorDate: '2025-01-02T10:00:00Z',
        committerDate: '2025-01-02T10:00:00Z',
        files: { 'src/activity.ts': 'export const pageSize = 25;\n' },
      },
      {
        type: 'commit',
        label: 'tests',
        subject: 'test: cover pagination boundaries',
        authorDate: '2025-01-02T11:00:00Z',
        committerDate: '2025-01-02T11:00:00Z',
        files: { 'test/activity.test.ts': 'export const coversPaginationBoundary = true;\n' },
      },
    ]);
    repos.push(repo);
    const agent = makeAgent({
      cwd: repo.path,
      env: { ORCAOPS_DISABLE_DRAIN: '1', CLAUDE_SESSION_ID: 'docs-output' },
    });

    const initialized = await agent.runRaw([
      'init',
      '--scope',
      'project',
      '--agents',
      'codex',
      '--no-llm',
      '--agents-md',
    ]);
    expect(initialized.exitCode).toBe(0);

    const seed = await agent.runRaw(['seed', '--dry-run']);
    expect(seed.exitCode).toBe(0);
    expect(await normalizePaths(seed.stdout, repo.path)).toBe(
      await documentedOutput('seed.md', 'seed-preview')
    );

    const evaluators = await agent.runRaw(['eval', 'list']);
    expect(evaluators.exitCode).toBe(0);
    expect(evaluators.stdout.trimEnd()).toBe(await documentedOutput('evaluators.md', 'eval-empty'));

    const doctor = await agent.runRaw(['doctor']);
    expect(doctor.exitCode).toBe(0);
    const normalizedDoctor = (await normalizePaths(doctor.stdout, repo.path)).replace(
      /^orcaops doctor — v\S+/u,
      'orcaops doctor — v<version>'
    );
    expect(normalizedDoctor).toBe(
      await documentedOutput('troubleshooting.md', 'doctor-seed-warning')
    );
  });
});
