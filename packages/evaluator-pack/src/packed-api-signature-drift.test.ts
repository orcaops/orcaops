import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import type { EvaluatorContext, EvaluatorResultEnvelope } from '@orcaops/evaluator-protocol';

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const packages = [
  '@orcaops/evaluator-protocol',
  '@orcaops/evaluator-sdk',
  '@orcaops/evaluator-pack',
] as const;

let scratch: string | undefined;

afterEach(async () => {
  if (scratch) await rm(scratch, { recursive: true, force: true });
  scratch = undefined;
});

function run(command: string, args: string[], cwd: string, env = process.env): string {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed (${result.status ?? result.signal}):\n` +
        `${result.stdout}\n${result.stderr}`
    );
  }
  return result.stdout;
}

function makeContext(repoRoot: string): EvaluatorContext {
  return {
    schema: 'orcaops.evaluator_context/v1',
    run_id: '019e0000-0000-7000-8000-000000000000',
    evaluator_ref: 'js/api-signature-drift',
    phase: 'checkpoint-close',
    artifact_id: '019e0000-0000-7000-8000-000000000001',
    checkpoint_n: 1,
    repo: { root: repoRoot, branch: 'main', base_sha: 'HEAD', head_sha: 'HEAD' },
    plan: {
      task: 'test packed evaluator runtime',
      label: 'test packed evaluator runtime',
      branch: 'main',
      base_sha: 'HEAD',
      agent: 'codex',
      agent_session_id: null,
      plan_steps: [],
      step_lineage: { added: [], dropped: [], unchanged: [], rewritten: [] },
      touched_scope: [],
      non_goals: [],
      decisions: [],
      revision_n: 0,
      revised_at: null,
      rationale: null,
      started_at: '2026-08-09T00:00:00.000Z',
    },
    prior_plan: null,
    source_plan: null,
    current_checkpoint: null,
    closed_checkpoints: [],
    open_checkpoints: [],
    abandoned_checkpoints: [],
    summary: null,
    changed_files: [],
    params: {},
  };
}

describe('packed api-signature-drift runtime', () => {
  it('loads TypeScript from evaluator-pack production dependencies', async () => {
    scratch = await realpath(await mkdtemp(path.join(tmpdir(), 'orcaops-evaluator-pack-prod-')));
    const tarballDir = path.join(scratch, 'tarballs');
    const installDir = path.join(scratch, 'install');
    await mkdir(tarballDir);
    await mkdir(installDir);
    await writeFile(
      path.join(installDir, 'package.json'),
      JSON.stringify({ name: 'packed-evaluator-test', private: true, dependencies: {} }),
      'utf8'
    );

    for (const packageName of packages) {
      run(
        'pnpm',
        ['--filter', packageName, 'pack', '--pack-destination', tarballDir],
        workspaceRoot
      );
    }
    const tarballs = (await readdir(tarballDir))
      .filter((entry) => entry.endsWith('.tgz'))
      .sort()
      .map((entry) => path.join(tarballDir, entry));
    expect(tarballs).toHaveLength(packages.length);

    run(
      'npm',
      // --no-audit: this installs to check module resolution, and npm's audit
      // endpoint can hang for minutes, which is budget this test does not have.
      // Dependency advisories are the production audit's job, not this test's.
      [
        'install',
        '--no-save',
        '--no-package-lock',
        '--omit=dev',
        '--ignore-scripts',
        '--no-audit',
        ...tarballs,
      ],
      installDir
    );

    const evaluatorPackRoot = path.join(installDir, 'node_modules', '@orcaops', 'evaluator-pack');
    const evaluatorManifest = JSON.parse(
      await readFile(path.join(evaluatorPackRoot, 'package.json'), 'utf8')
    ) as { dependencies?: Record<string, string> };
    expect(evaluatorManifest.dependencies?.typescript).toBe('5.9.2');

    const installedRequire = createRequire(path.join(evaluatorPackRoot, 'package.json'));
    const typescriptEntry = await realpath(installedRequire.resolve('typescript'));
    expect(typescriptEntry.startsWith(`${installDir}${path.sep}`)).toBe(true);

    const contextPath = path.join(scratch, 'context.json');
    await writeFile(contextPath, JSON.stringify(makeContext(installDir)), 'utf8');
    const runtimeRoot = path.join(evaluatorPackRoot, 'dist', 'packs', 'js');
    const stdout = run('node', ['./runtime/api-signature-drift.js'], runtimeRoot, {
      ...process.env,
      ORCAOPS_CONTEXT_PATH: contextPath,
    });
    const envelope = JSON.parse(stdout.trim()) as EvaluatorResultEnvelope;
    expect(envelope.verdict).toBe('pass');
    expect(envelope.body).toMatch(/No TS\/JS files in scope changed/);

    // The authoring helpers must survive packing too. A pack author reaches
    // makeContext / runLlmFixture through the published tarball, not through
    // the workspace, so an export missing from `files` or the exports map
    // would leave the documented testing loop unreachable.
    const probe = path.join(installDir, 'probe-sdk.mjs');
    await writeFile(
      probe,
      [
        "import { makeContext, makePlanStep, runFixture, runLlmFixture } from '@orcaops/evaluator-sdk';",
        "if (typeof runFixture !== 'function') throw new Error('runFixture missing');",
        'const ctx = makeContext({',
        "  plan: { ...makeContext().plan, plan_steps: [makePlanStep(1, 'ship the suite')] },",
        '});',
        'const out = runLlmFixture({',
        '  context: ctx,',
        "  promptBody: 'Grade the delivery.',",
        "  additionalContextSections: ['acceptance-criteria'],",
        "  response: '```orcaops-verdict\\nVIOLATION\\n```',",
        '});',
        'process.stdout.write(JSON.stringify({',
        '  verdict: out.verdict,',
        "  hasTask: out.prompt.includes('## Task'),",
        "  hasRubric: out.contextBlock.includes('## Acceptance criteria'),",
        '}));',
        '',
      ].join('\n'),
      'utf8'
    );
    const probeOut = JSON.parse(run('node', ['./probe-sdk.mjs'], installDir)) as {
      verdict: string;
      hasTask: boolean;
      hasRubric: boolean;
    };
    expect(probeOut).toEqual({ verdict: 'violation', hasTask: true, hasRubric: true });

    // Running the probe proves the exports resolve; it cannot see the TYPES a
    // consumer compiles against. An over-narrow annotation — makePlanStep once
    // published `acceptance_criteria: []`, an empty tuple nothing could be
    // pushed onto — passes at runtime and fails the moment someone writes
    // TypeScript. Typecheck a consumer against the installed .d.ts files.
    await writeFile(
      path.join(installDir, 'tsconfig.probe.json'),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          noEmit: true,
          // Skips checking INSIDE .d.ts files (they reference NodeJS types a
          // --omit=dev install does not provide) while still inferring from
          // them, which is the contract this probe is about.
          skipLibCheck: true,
          module: 'nodenext',
          moduleResolution: 'nodenext',
          target: 'es2022',
          types: [],
        },
        files: ['probe-types.ts'],
      }),
      'utf8'
    );
    await writeFile(
      path.join(installDir, 'probe-types.ts'),
      [
        "import { makeContext, makePlanStep } from '@orcaops/evaluator-sdk';",
        "import type { EvaluatorContext } from '@orcaops/evaluator-sdk';",
        '',
        'const ctx: EvaluatorContext = makeContext();',
        "const step = makePlanStep(1, 'ship the suite');",
        '// The published type must let a consumer populate the rubric.',
        "step.acceptance_criteria.push({ criterion_id: 'crit-1', text: 'at least 42 tests' });",
        'export const stepCount: number = makeContext({',
        '  plan: { ...ctx.plan, plan_steps: [step] },',
        '}).plan.plan_steps.length;',
        '',
      ].join('\n'),
      'utf8'
    );
    // evaluator-pack declares typescript as a PRODUCTION dependency (asserted
    // above), so the tarball install already provides a compiler — no network
    // fetch, and the same version a consumer of this pack would resolve.
    const tsc = path.join(installDir, 'node_modules', '.bin', 'tsc');
    run(tsc, ['--project', 'tsconfig.probe.json'], installDir);
  }, 180_000);
});
