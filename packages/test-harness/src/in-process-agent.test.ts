import { AsyncLocalStorage } from 'node:async_hooks';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { inputFile } from './agent-helpers.js';
import { InProcessAgent, type ProgramLike } from './in-process-agent.js';

// ── Mock CLI ────────────────────────────────────────────────────────────
//
// A tiny ProgramLike that mimics the orcaops CLI's expected behaviors:
// writes JSON envelopes to stdout, throws CliExit-shaped errors for
// non-zero exits, honors a passed ALS for cwd/env reads. Lets us
// exercise the harness without a runtime dep on @orcaops/cli or
// commander.

const mockAls = new AsyncLocalStorage<{ cwd?: string; env?: NodeJS.ProcessEnv }>();

function mockRunInInvocationContext<T>(
  ctx: { cwd?: string; env?: NodeJS.ProcessEnv },
  fn: () => T | Promise<T>
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    mockAls.run(ctx, () => {
      Promise.resolve().then(fn).then(resolve, reject);
    });
  });
}

function mockCwd(): string {
  return mockAls.getStore()?.cwd ?? process.cwd();
}

function mockEnv(): NodeJS.ProcessEnv {
  return mockAls.getStore()?.env ?? process.env;
}

class MockCliExit extends Error {
  constructor(public readonly code: number) {
    super(`CliExit(${code})`);
    this.name = 'CliExit';
  }
}

function buildMockProgram(): ProgramLike {
  return {
    async parseAsync(args: readonly string[]): Promise<unknown> {
      const [cmd, ...rest] = args;
      switch (cmd) {
        case 'echo-cwd': {
          process.stdout.write(JSON.stringify({ ok: true, cwd: mockCwd() }) + '\n');
          return;
        }
        case 'echo-env': {
          const key = rest[0] ?? '';
          process.stdout.write(JSON.stringify({ ok: true, value: mockEnv()[key] ?? null }) + '\n');
          return;
        }
        case 'emit-error': {
          process.stdout.write(
            JSON.stringify({
              ok: false,
              error: { code: 'TEST_ERROR', message: 'planned failure' },
            }) + '\n'
          );
          throw new MockCliExit(1);
        }
        case 'write-stderr': {
          process.stderr.write('this is stderr\n');
          process.stdout.write(JSON.stringify({ ok: true }) + '\n');
          return;
        }
        case 'rogue-exit': {
          // Simulates a deeper node_modules-level rogue exit — should
          // be intercepted by the harness's defense-in-depth fuse.
          process.exit(7);
          return;
        }
        case 'slow': {
          await new Promise((resolve) => setTimeout(resolve, 50));
          process.stdout.write(JSON.stringify({ ok: true, slept: 50 }) + '\n');
          return;
        }
        default:
          throw new Error(`mock CLI: unknown command "${cmd}"`);
      }
    },
  };
}

function makeAgent(
  opts: { cwd?: string; env?: Record<string, string>; timeoutMs?: number } = {}
): InProcessAgent {
  return new InProcessAgent({
    cwd: opts.cwd ?? process.cwd(),
    env: opts.env,
    timeoutMs: opts.timeoutMs,
    buildProgram: buildMockProgram,
    runInInvocationContext: mockRunInInvocationContext,
  });
}

describe('InProcessAgent', () => {
  it('captures stdout into the call result', async () => {
    const agent = makeAgent();
    const result = await agent.runRaw(['echo-cwd']);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    const parsed = JSON.parse(result.stdout) as { ok: true; cwd: string };
    expect(parsed.ok).toBe(true);
    expect(parsed.cwd).toBe(process.cwd());
  });

  it('threads `cwd` to the CLI via runInInvocationContext', async () => {
    const customCwd = '/tmp/in-process-agent-test-' + Date.now();
    const agent = makeAgent({ cwd: customCwd });
    const result = await agent.runRaw(['echo-cwd']);
    const parsed = JSON.parse(result.stdout) as { cwd: string };
    expect(parsed.cwd).toBe(customCwd);
  });

  it('threads `env` to the CLI via runInInvocationContext', async () => {
    const agent = makeAgent({ env: { TEST_VAR: 'hello-world' } });
    const result = await agent.runRaw(['echo-env', 'TEST_VAR']);
    const parsed = JSON.parse(result.stdout) as { value: string };
    expect(parsed.value).toBe('hello-world');
  });

  it('captures stderr separately from stdout', async () => {
    const agent = makeAgent();
    const result = await agent.runRaw(['write-stderr']);
    expect(result.stderr).toBe('this is stderr\n');
    expect(result.stdout).toContain('"ok":true');
  });

  it('surfaces CliExit-shaped throws as the exit code', async () => {
    const agent = makeAgent();
    const result = await agent.runRaw(['emit-error']);
    expect(result.exitCode).toBe(1);
    const parsed = JSON.parse(result.stdout) as { ok: false; error: { code: string } };
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe('TEST_ERROR');
  });

  it('fuse intercepts a rogue process.exit deep in the CLI', async () => {
    const agent = makeAgent();
    await expect(agent.runRaw(['rogue-exit'])).rejects.toThrow(/fuse fired/);
  });

  it('expectError returns the parsed error envelope', async () => {
    const agent = makeAgent();
    const env = await agent.expectError(['emit-error']);
    expect(env.error.code).toBe('TEST_ERROR');
    expect(env.error.message).toBe('planned failure');
  });

  it('refuses stdin (`-`) on --input', async () => {
    const agent = makeAgent();
    await expect(agent.runRaw(['capture', 'plan', '--input', '-'])).rejects.toThrow(/stdin/);
  });

  it('refuses a `stdin` opt', async () => {
    const agent = makeAgent();
    await expect(
      agent.runRaw(['capture', 'plan', '--input', inputFile('{}')], { stdin: 'payload' })
    ).rejects.toThrow(/stdin payload/);
  });

  it('per-agent mutex serializes same-agent calls', async () => {
    const agent = makeAgent();
    const order: string[] = [];

    const first = agent.runRaw(['slow']).then(() => order.push('first-done'));
    const second = agent.runRaw(['echo-cwd']).then(() => order.push('second-done'));

    await Promise.all([first, second]);
    expect(order).toEqual(['first-done', 'second-done']);
  });

  it('different agents run in parallel with isolated env via ALS', async () => {
    // Two agents with distinct env vars. Each agent runs `echo-env` and
    // sees its own value — proving ALS frames don't leak across the
    // concurrent calls.
    const agentA = makeAgent({ env: { ISO_TEST: 'value-a' } });
    const agentB = makeAgent({ env: { ISO_TEST: 'value-b' } });

    const [resA, resB] = await Promise.all([
      agentA.runRaw(['echo-env', 'ISO_TEST']),
      agentB.runRaw(['echo-env', 'ISO_TEST']),
    ]);

    const parsedA = JSON.parse(resA.stdout) as { value: string };
    const parsedB = JSON.parse(resB.stdout) as { value: string };
    expect(parsedA.value).toBe('value-a');
    expect(parsedB.value).toBe('value-b');
  });

  it('different agents run in parallel with isolated cwd via ALS', async () => {
    const agentA = makeAgent({ cwd: '/tmp/isolated-a' });
    const agentB = makeAgent({ cwd: '/tmp/isolated-b' });

    const [resA, resB] = await Promise.all([
      agentA.runRaw(['echo-cwd']),
      agentB.runRaw(['echo-cwd']),
    ]);

    const parsedA = JSON.parse(resA.stdout) as { cwd: string };
    const parsedB = JSON.parse(resB.stdout) as { cwd: string };
    expect(parsedA.cwd).toBe('/tmp/isolated-a');
    expect(parsedB.cwd).toBe('/tmp/isolated-b');
  });

  it('sets ORCAOPS_NO_SPINNER=1 by default', async () => {
    const agent = makeAgent();
    const result = await agent.runRaw(['echo-env', 'ORCAOPS_NO_SPINNER']);
    const parsed = JSON.parse(result.stdout) as { value: string };
    expect(parsed.value).toBe('1');
  });

  it('caller env override takes precedence over ORCAOPS_NO_SPINNER default', async () => {
    const agent = makeAgent({ env: { ORCAOPS_NO_SPINNER: '0' } });
    const result = await agent.runRaw(['echo-env', 'ORCAOPS_NO_SPINNER']);
    const parsed = JSON.parse(result.stdout) as { value: string };
    expect(parsed.value).toBe('0');
  });

  it('timeout surfaces as a rejected promise', async () => {
    const agent = makeAgent({ timeoutMs: 10 });
    await expect(agent.runRaw(['slow'])).rejects.toThrow(/timed out after 10ms/);
  });
});

// ── captureCheckpoint convenience wrapper ───────────────────────────────
//
// The wrapper opens a checkpoint, then closes it. It must thread the
// *open's* server-assigned `n` into the close — not whatever `n` the caller
// passed (or none). A mock ProgramLike that assigns `n` on open and records
// the `n` close received lets us prove the threading without a runtime dep
// on the real `@orcaops/cli` checkpoint commands.

describe('InProcessAgent.captureCheckpoint (n threading)', () => {
  // Builds a checkpoint-aware mock: `open` assigns an incrementing `n`
  // (seeded high so it can't be confused with a default/1), `close`
  // records the payload it received and echoes its `n` back.
  function buildCheckpointMock(opts: {
    firstN: number;
    closeInputs: Array<Record<string, unknown>>;
  }) {
    let nextN = opts.firstN - 1;
    return (): ProgramLike => ({
      async parseAsync(args: readonly string[]): Promise<unknown> {
        // args: ['capture', 'checkpoint', <'open'|'close'>, '--input', '<path>']
        const sub = args[2];
        const inputIdx = args.indexOf('--input');
        const payload = JSON.parse(readFileSync(String(args[inputIdx + 1]), 'utf8')) as Record<
          string,
          unknown
        >;
        if (sub === 'open') {
          nextN += 1;
          process.stdout.write(
            JSON.stringify({
              ok: true,
              artifact_id: payload.artifact_id,
              n: nextN,
              status: 'open',
              declared_step_ids: payload.declared_step_ids ?? [],
            }) + '\n'
          );
          return;
        }
        if (sub === 'close') {
          opts.closeInputs.push(payload);
          process.stdout.write(
            JSON.stringify({
              ok: true,
              artifact_id: payload.artifact_id,
              n: payload.n ?? null,
              status: 'closed',
            }) + '\n'
          );
          return;
        }
        throw new Error(`checkpoint mock: unexpected args "${args.join(' ')}"`);
      },
    });
  }

  it("threads the open's server-assigned n into the close call", async () => {
    const closeInputs: Array<Record<string, unknown>> = [];
    const agent = new InProcessAgent({
      cwd: process.cwd(),
      // Seed so the first open returns n=42 — a value the caller never
      // supplies, so the assertion can only pass if close got the open's n.
      buildProgram: buildCheckpointMock({ firstN: 42, closeInputs }),
      runInInvocationContext: mockRunInInvocationContext,
    });

    // Pass completed_step_ids so the wrapper derives declared scope directly
    // and never calls `show` (which the mock doesn't implement).
    await agent.captureCheckpoint({ artifact_id: 'a1', completed_step_ids: ['s1'] });

    expect(closeInputs).toHaveLength(1);
    // The close must carry the open's server-assigned n (42); the caller's
    // body supplies no `n` of its own.
    expect(closeInputs[0].n).toBe(42);
    expect(closeInputs[0].verification).toEqual([{ command: 'test fixture', exit_code: 0 }]);
  });
});
