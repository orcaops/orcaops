import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_CLOUD_BASE_URL } from '@orcaops/core';
import { uuidv7 } from '@orcaops/storage';

import { fixture, git } from '../../tests/helpers/database-history.js';
import { buildProgram } from '../cli/program.js';
import { runInInvocationContext } from '../lib/invocation-context.js';

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

async function temporaryDirectory(prefix: string) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), prefix)));
  directories.push(directory);
  return directory;
}

async function run(cwd: string, env: NodeJS.ProcessEnv, argv: readonly string[]) {
  const writes: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    writes.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  let exitCode = 0;
  try {
    await runInInvocationContext({ cwd, env }, async () => {
      const program = buildProgram({ cloudBaseUrl: DEFAULT_CLOUD_BASE_URL });
      program.exitOverride();
      try {
        await program.parseAsync([...argv], { from: 'user' });
      } catch (cause) {
        exitCode = (cause as { code?: number }).code ?? 1;
      }
    });
  } finally {
    vi.mocked(process.stdout.write).mockRestore();
    vi.mocked(process.stderr.write).mockRestore();
  }
  const output = writes.join('');
  return { exitCode, envelope: JSON.parse(output) as { ok: boolean; error?: unknown } };
}

async function environment(dataRoot: string) {
  return {
    PATH: process.env.PATH,
    HOME: await temporaryDirectory('orcaops-home-'),
    XDG_STATE_HOME: await temporaryDirectory('orcaops-state-'),
    ORCAOPS_DATA_DIR: dataRoot,
    ORCAOPS_CLOUD_FEATURES: '0',
    CLAUDE_SESSION_ID: 'history-unavailable-refusals',
  };
}

const wrongRootRefusal = {
  ok: false,
  error: {
    code: 'AUTHORITY_MISMATCH',
    message: expect.stringContaining('Set ORCAOPS_DATA_DIR to the registered root'),
  },
};

describe('history commands opened against the wrong data root', { timeout: 60_000 }, () => {
  async function wrongRoot() {
    const f = await fixture();
    const stepId = uuidv7();
    const artifactId = await f.capture(undefined, {
      steps: [
        {
          step_id: stepId,
          text: 'Read retained evidence',
          label: 'Retained evidence',
          acceptance_criteria: [],
        },
      ],
    });
    const registered = await environment(f.root);
    const env = await environment(await temporaryDirectory('orcaops-other-root-'));
    return { f, artifactId, stepId, registered, env };
  }

  it('show refuses with the registration issue that names the registered root', async () => {
    const { f, artifactId, registered, env } = await wrongRoot();
    expect((await run(f.main, registered, ['show', artifactId, '--json'])).envelope.ok).toBe(true);
    const refused = await run(f.main, env, ['show', artifactId, '--json']);
    expect(refused.exitCode).not.toBe(0);
    expect(refused.envelope).toMatchObject(wrongRootRefusal);
  });

  it('step brief refuses with the registration issue that names the registered root', async () => {
    const { f, artifactId, stepId, registered, env } = await wrongRoot();
    const argv = ['step', 'brief', stepId, '--artifact', artifactId, '--json'];
    expect((await run(f.main, registered, argv)).envelope.ok).toBe(true);
    const refused = await run(f.main, env, argv);
    expect(refused.exitCode).not.toBe(0);
    expect(refused.envelope).toMatchObject(wrongRootRefusal);
  });

  it('capture refuses with the registration issue instead of a fixed instruction', async () => {
    const { f, env } = await wrongRoot();
    const input = path.join(await temporaryDirectory('orcaops-plan-'), 'plan.yaml');
    await writeFile(
      input,
      [
        'task: Keep the registered history',
        'label: Keep the registered history',
        'plan_steps:',
        '  - text: Read retained evidence',
        '    label: Retained evidence',
        'touched_scope: []',
        'non_goals: []',
        '',
      ].join('\n')
    );
    const refused = await run(f.main, env, ['capture', 'plan', '--input', input]);
    expect(refused.exitCode).not.toBe(0);
    expect(refused.envelope).toMatchObject(wrongRootRefusal);
  });

  it('checkout refuses with the registration issue instead of a fixed instruction', async () => {
    const { f, artifactId, env } = await wrongRoot();
    const refused = await run(f.main, env, ['checkout', artifactId, '--json']);
    expect(refused.exitCode).not.toBe(0);
    expect(refused.envelope).toMatchObject(wrongRootRefusal);
  });

  it('implicit digest refuses with the registration issue instead of a fixed instruction', async () => {
    const { f, env } = await wrongRoot();
    const refused = await run(f.main, env, ['digest', '--json']);
    expect(refused.exitCode).not.toBe(0);
    expect(refused.envelope).toMatchObject(wrongRootRefusal);
    expect(refused.envelope.error).toMatchObject({ path: 'branch' });
  });
});

describe('history commands in a repository with no registration', { timeout: 60_000 }, () => {
  async function unregistered() {
    const cwd = await temporaryDirectory('orcaops-unregistered-');
    await git(cwd, ['init', '-qb', 'main']);
    await git(cwd, ['commit', '--allow-empty', '-qm', 'Initial']);
    return { cwd, env: await environment(await temporaryDirectory('orcaops-data-')) };
  }
  const unregisteredRefusal = {
    ok: false,
    error: {
      code: 'PROJECT_IDENTITY_UNAVAILABLE',
      message: expect.stringContaining('Run `orcaops doctor` before recovery'),
    },
  };

  it('implicit resume refuses with the registration issue instead of a fixed instruction', async () => {
    const { cwd, env } = await unregistered();
    const refused = await run(cwd, env, ['resume', '--json']);
    expect(refused.exitCode).not.toBe(0);
    expect(refused.envelope).toMatchObject(unregisteredRefusal);
  });

  it('implicit digest refuses with the registration issue instead of a fixed instruction', async () => {
    const { cwd, env } = await unregistered();
    const refused = await run(cwd, env, ['digest', '--json']);
    expect(refused.exitCode).not.toBe(0);
    expect(refused.envelope).toMatchObject(unregisteredRefusal);
  });
});
