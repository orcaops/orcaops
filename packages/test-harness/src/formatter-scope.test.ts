// RELEASE-GATE GUARD: every workspace formatter must ignore generated output.
//
// Package `format:check` scripts run prettier from the package directory, so
// the root `.prettierignore` never applies to them — each workspace needs its
// own effective ignore configuration (a package-local `.prettierignore`, a
// `.gitignore` prettier picks up by default, or an explicit `--ignore-path`
// flag in the script itself). When a workspace lacks one, any `pnpm build`
// makes the root `pnpm format:check` fail on generated `dist/` files even
// though every tracked source is clean.
//
// This test plants a deliberately misformatted probe file in each formatter
// workspace's `dist/` and asserts the workspace's own prettier invocation
// (same cwd, same `--ignore-path` flags as its script) does not see it.
// Workspaces are discovered from their package.json scripts, so a newly added
// package is covered the day it gains a `format:check` script.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');

const require = createRequire(import.meta.url);
const PRETTIER_BIN = path.join(
  path.dirname(require.resolve('prettier/package.json', { paths: [REPO_ROOT] })),
  'bin',
  'prettier.cjs'
);

const PROBE_NAME = '__formatter_scope_probe__.js';
// Misformatted under any shared config: double spaces, missing spacing, `;;`.
const PROBE_CONTENT = 'const  probe=1 ;;\n';

interface FormatterWorkspace {
  /** Repo-relative directory, e.g. `packages/storage`. */
  dir: string;
  /** `--ignore-path` values the workspace's own script passes, if any. */
  ignorePaths: string[];
}

const discoverFormatterWorkspaces = (): FormatterWorkspace[] => {
  const workspaces: FormatterWorkspace[] = [];
  for (const group of ['apps', 'packages']) {
    const groupDir = path.join(REPO_ROOT, group);
    for (const entry of readdirSync(groupDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifestPath = path.join(groupDir, entry.name, 'package.json');
      if (!existsSync(manifestPath)) continue;
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
        scripts?: Record<string, string>;
      };
      const script = manifest.scripts?.['format:check'];
      if (!script) continue;
      const ignorePaths = [...script.matchAll(/--ignore-path[ =](\S+)/g)].map((m) => m[1]);
      workspaces.push({ dir: `${group}/${entry.name}`, ignorePaths });
    }
  }
  return workspaces;
};

interface WorkspaceManifest {
  scripts?: Record<string, string>;
}

interface FlatEslintConfig {
  ignores?: string[];
}

const discoverWorkspaceDirs = (): Array<{ dir: string; manifest: WorkspaceManifest }> => {
  const workspaces: Array<{ dir: string; manifest: WorkspaceManifest }> = [];
  for (const group of ['apps', 'packages']) {
    const groupDir = path.join(REPO_ROOT, group);
    for (const entry of readdirSync(groupDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifestPath = path.join(groupDir, entry.name, 'package.json');
      if (!existsSync(manifestPath)) continue;
      workspaces.push({
        dir: `${group}/${entry.name}`,
        manifest: JSON.parse(readFileSync(manifestPath, 'utf8')) as WorkspaceManifest,
      });
    }
  }
  return workspaces;
};

const rootDelegatesWorkspace = (workspaceDir: string, ignores: string[]): boolean =>
  ignores.some((ignore) => {
    if (!ignore.endsWith('/**')) return false;
    const delegatedDir = ignore.slice(0, -3);
    return workspaceDir === delegatedDir || workspaceDir.startsWith(`${delegatedDir}/`);
  });

const delegatedLintWorkspaces = async (): Promise<string[]> => {
  const rootConfigUrl = pathToFileURL(path.join(REPO_ROOT, 'eslint.config.js')).href;
  const rootConfigModule = (await import(rootConfigUrl)) as {
    default: FlatEslintConfig[];
  };
  const rootIgnores = rootConfigModule.default.flatMap((config) => config.ignores ?? []);

  return discoverWorkspaceDirs()
    .filter(
      ({ dir, manifest }) =>
        Boolean(manifest.scripts?.lint) && rootDelegatesWorkspace(dir, rootIgnores)
    )
    .map(({ dir }) => dir)
    .sort();
};

/** Exit code of the workspace's prettier check aimed at the planted probe. */
const checkProbe = (workspace: FormatterWorkspace): number => {
  const cwd = path.join(REPO_ROOT, workspace.dir);
  const ignoreFlags = workspace.ignorePaths.flatMap((p) => ['--ignore-path', p]);
  const result = spawnSync(
    process.execPath,
    [PRETTIER_BIN, '--check', ...ignoreFlags, `dist/${PROBE_NAME}`],
    { cwd, encoding: 'utf8' }
  );
  if (result.error) throw result.error;
  return result.status ?? 1;
};

describe('formatter scope', () => {
  it('every format:check workspace ignores generated dist/ output', { timeout: 120_000 }, () => {
    const workspaces = discoverFormatterWorkspaces();
    // Vacuity guard: discovery breaking must fail loudly, not pass on zero
    // workspaces. The conservative floor allows intentional workspace removal.
    expect(workspaces.length).toBeGreaterThanOrEqual(10);

    const unscoped: string[] = [];
    for (const workspace of workspaces) {
      const distDir = path.join(REPO_ROOT, workspace.dir, 'dist');
      const createdDist = !existsSync(distDir);
      if (createdDist) mkdirSync(distDir, { recursive: true });
      const probePath = path.join(distDir, PROBE_NAME);
      try {
        writeFileSync(probePath, PROBE_CONTENT);
        if (checkProbe(workspace) !== 0) unscoped.push(workspace.dir);
      } finally {
        rmSync(probePath, { force: true });
        if (createdDist) rmSync(distDir, { recursive: true, force: true });
      }
    }

    expect(
      unscoped,
      `these workspaces' formatters see generated dist/ output; add a package-local ` +
        `.prettierignore (dist/, node_modules/) so a build cannot fail format:check`
    ).toEqual([]);
  });
});

describe('lint-staged scope', () => {
  it('delegated lint workspaces run their local ESLint rules in the staged-file hook', async () => {
    const workspaces = await delegatedLintWorkspaces();
    // Vacuity guard: the root delegates application workspaces and diff-render.
    // If config loading or workspace discovery breaks, this contract must fail
    // rather than silently checking nothing.
    expect(workspaces.length).toBeGreaterThanOrEqual(3);

    const missingLocalEslint: string[] = [];
    for (const workspace of workspaces) {
      const configPath = path.join(REPO_ROOT, workspace, '.lintstagedrc.json');
      if (!existsSync(configPath)) {
        missingLocalEslint.push(workspace);
        continue;
      }
      const config = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, string[]>;
      if (!config['*.{ts,tsx,js,jsx}']?.includes('eslint --fix')) {
        missingLocalEslint.push(workspace);
      }
    }

    expect(
      missingLocalEslint,
      `root ESLint ignores these workspaces, so their nearest lint-staged config must ` +
        `run eslint --fix with the workspace's own flat config`
    ).toEqual([]);
  });
});

describe('root test policy', () => {
  it('pins root test concurrency and isolated temporary roots', () => {
    const rootManifest = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    expect(rootManifest.scripts?.test).toBe('node scripts/run-tests.mjs');
    expect(rootManifest.scripts?.['test:coverage']).toBe('node scripts/run-tests.mjs --coverage');

    const policyResult = spawnSync(
      process.execPath,
      [path.join(REPO_ROOT, 'scripts/run-tests.mjs'), '--print-policy'],
      { cwd: REPO_ROOT, encoding: 'utf8' }
    );
    if (policyResult.error) throw policyResult.error;
    expect(policyResult.status).toBe(0);
    expect(JSON.parse(policyResult.stdout)).toEqual({
      turboConcurrency: '25%',
      vitestWorkerShare: 0.25,
      vitestWorkerFloor: 2,
      vitestWorkerCap: 4,
      vitestCoverageWorkers: 2,
      reporter: 'dot',
      silent: 'passed-only',
      isolatedTempRoot: true,
    });
  });

  it('rejects a pattern passed to --exclude', () => {
    // Turbo treats a glob that matches nothing as a no-op rather than an error,
    // so a mistyped pattern would silently run every workspace — which in CI
    // means going back to running the CLI suite twice per build without anyone
    // noticing. Only exact names are accepted, and those fail loudly in turbo.
    const result = spawnSync(
      process.execPath,
      [path.join(REPO_ROOT, 'scripts/run-tests.mjs'), '--exclude=@orcaops/*typo*'],
      { cwd: REPO_ROOT, encoding: 'utf8' }
    );
    if (result.error) throw result.error;
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('exact workspace name');
  });

  it('drops the worker ceiling for a coverage run', () => {
    // V8 instrumentation inflates every test's wall clock on top of the
    // contention the ceiling already bounds, so the bound that is safe
    // uninstrumented is not: the CLI suite under coverage failed four tests at
    // vitest's default, one at the cap, and none at the floor.
    const policy = JSON.parse(
      spawnSync(
        process.execPath,
        [path.join(REPO_ROOT, 'scripts/run-tests.mjs'), '--print-policy'],
        {
          cwd: REPO_ROOT,
          encoding: 'utf8',
        }
      ).stdout
    ) as { vitestWorkerCap: number; vitestCoverageWorkers: number };
    expect(policy.vitestCoverageWorkers).toBeLessThan(policy.vitestWorkerCap);
  });

  it('keeps the CI test job excluding the CLI from the shared leg', () => {
    // The CLI's coverage leg runs the same suite; without this exclusion the
    // job executes all of it twice. Nothing else asserts the workflow's shape.
    const workflow = readFileSync(path.join(REPO_ROOT, '.github/workflows/ci.yml'), 'utf8');
    expect(workflow).toContain('pnpm test --exclude=@orcaops/cli');
    // The coverage leg must stay on the root runner: calling vitest directly
    // bypasses the worker ceiling, which is what made it the flakiest leg.
    expect(workflow).toContain('pnpm test --coverage --only=@orcaops/cli');
    expect(workflow).not.toContain('pnpm --filter @orcaops/cli test:coverage');
  });

  it('keeps the coverage gate ahead of the watch legs', () => {
    // Behind them the gate never ran at all: the watch legs fail on ubuntu for
    // reasons of their own, and a step that cannot execute cannot gate
    // anything. A plain string match would not notice a reordering, so assert
    // the positions rather than the presence.
    const workflow = readFileSync(path.join(REPO_ROOT, '.github/workflows/ci.yml'), 'utf8');
    const coverage = workflow.indexOf('pnpm test --coverage --only=@orcaops/cli');
    const pty = workflow.indexOf('pnpm --filter @orcaops/watch test:pty');
    expect(coverage).toBeGreaterThan(-1);
    expect(pty).toBeGreaterThan(-1);
    expect(coverage).toBeLessThan(pty);
  });
});
