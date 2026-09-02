import { describe, expect, it, vi } from 'vitest';

import { CLOUD_HIDDEN_COMMANDS } from '@orcaops/adapters';
import { DEFAULT_CLOUD_BASE_URL } from '@orcaops/core';

import { buildProgram, makeCaptureFlagAdapter } from './program.js';
import { runInInvocationContext } from '../lib/invocation-context.js';

/**
 * Build the program with the gate forced, inside the invocation frame the gate
 * reads. Without the frame these assertions would depend on whether the
 * developer running the suite happens to be logged in.
 */
function programWithCloud(cloud: boolean): Promise<ReturnType<typeof buildProgram>> {
  return runInInvocationContext(
    { cwd: process.cwd(), env: { ...process.env, ORCAOPS_CLOUD_FEATURES: cloud ? '1' : '0' } },
    () => buildProgram({ cloudBaseUrl: DEFAULT_CLOUD_BASE_URL })
  );
}

/**
 * Every command path in the tree, subcommands spelled with their parent.
 *
 * Visibility comes from `Help.visibleCommands`, the public API commander's own
 * help renderer uses, rather than the private `_hidden` field: a renamed
 * private field would make this silently report nothing hidden. Membership,
 * not length — `visibleCommands` appends a placeholder for the implicit help
 * command, so the counts do not line up.
 */
function commandPaths(
  program: ReturnType<typeof buildProgram>
): { path: string; hidden: boolean }[] {
  const helper = program.createHelp();
  const out: { path: string; hidden: boolean }[] = [];
  const walk = (cmd: ReturnType<typeof buildProgram>, prefix: string): void => {
    const visible = new Set(helper.visibleCommands(cmd));
    for (const sub of cmd.commands) {
      const p = prefix ? `${prefix} ${sub.name()}` : sub.name();
      out.push({ path: p, hidden: !visible.has(sub) });
      walk(sub as ReturnType<typeof buildProgram>, p);
    }
  };
  walk(program, '');
  return out;
}

const buildOfficialProgram = () => buildProgram({ cloudBaseUrl: DEFAULT_CLOUD_BASE_URL });

/** Parse argv against the real program with exits captured, not taken. */
async function parseExpectingFailure(argv: string[]): Promise<{ code?: string }> {
  const program = buildOfficialProgram();
  program.exitOverride();
  program.configureOutput({ writeErr: () => undefined, writeOut: () => undefined });
  try {
    await program.parseAsync(argv, { from: 'user' });
  } catch (err) {
    return err as { code?: string };
  }
  throw new Error('expected parsing to fail');
}

describe('orcaops CLI program', () => {
  it('documents both why modes and whole-file detail expansion', () => {
    const why = buildOfficialProgram().commands.find((command) => command.name() === 'why');
    expect(why).toBeDefined();
    const help = why!.helpInformation();
    expect(help).toContain('complete newest-first history for <file>');
    expect(help).toContain('attribute <file>:<line>');
    expect(help).toContain('Expand whole-file details');
    expect(help).toContain('list every line candidate');
  });

  it('has no public cloud-target selector', () => {
    const visit = (command: ReturnType<typeof buildOfficialProgram>): string[] => [
      ...command.options.map((option) => option.long).filter((name): name is string => !!name),
      ...command.commands.flatMap((child) => visit(child)),
    ];

    expect(visit(buildOfficialProgram())).not.toContain('--base-url');
  });

  it('rejects an unsafe injected cloud target before parsing commands', () => {
    expect(() => buildProgram({ cloudBaseUrl: 'http://cloud.example' })).toThrow(/https/i);
  });

  it('routes cloud commands to the injected target', async () => {
    const writes: string[] = [];
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });
    try {
      await buildProgram({ cloudBaseUrl: 'https://development.example' }).parseAsync(
        ['auth-state'],
        { from: 'user' }
      );
    } finally {
      stdout.mockRestore();
    }

    expect(JSON.parse(writes.join(''))).toMatchObject({
      ok: true,
      baseUrl: 'https://development.example',
    });
  });

  it('is named "orcaops"', () => {
    const program = buildOfficialProgram();
    expect(program.name()).toBe('orcaops');
  });

  it('has a description', () => {
    const program = buildOfficialProgram();
    expect(program.description()).toMatch(/AI coding sessions/i);
  });

  it('exposes a version string', () => {
    const program = buildOfficialProgram();
    expect(program.version()).toMatch(/^\d+\.\d+\.\d+/);
  });

  describe('the cloud surface gate', () => {
    it('hides exactly the shared hidden-command list without credentials', async () => {
      const hidden = commandPaths(await programWithCloud(false))
        .filter((c) => c.hidden)
        .map((c) => c.path)
        .sort();
      expect(hidden).toEqual([...CLOUD_HIDDEN_COMMANDS].sort());
    });

    it('hides nothing with credentials', async () => {
      expect(commandPaths(await programWithCloud(true)).filter((c) => c.hidden)).toEqual([]);
    });

    it('keeps login visible either way — it is how you reach the cloud', async () => {
      for (const cloud of [true, false]) {
        const login = commandPaths(await programWithCloud(cloud)).find((c) => c.path === 'login');
        expect(login, `login missing with cloud=${cloud}`).toBeDefined();
        expect(login!.hidden).toBe(false);
      }
    });

    it('reads the invocation frame, not the ambient process env', async () => {
      // A `--help` disagreeing with `skills list` in one run is incoherent.
      const outer = { ...process.env, ORCAOPS_CLOUD_FEATURES: '1' };
      const hidden = await runInInvocationContext({ cwd: process.cwd(), env: outer }, () =>
        commandPaths(buildProgram({ cloudBaseUrl: DEFAULT_CLOUD_BASE_URL })).filter((c) => c.hidden)
      );
      expect(hidden).toEqual([]);
    });
  });

  it('init help carries no --agent flag (retired install-seed alias)', () => {
    const init = buildOfficialProgram().commands.find((command) => command.name() === 'init');
    expect(init).toBeDefined();
    const help = init!.helpInformation();
    expect(help).not.toMatch(/--agent <id>/);
    expect(help).toContain('--agents <list>');
    expect(help).toContain('--install-agent <id>');
  });

  it('describes --no-llm as a skip and never claims an unevaluated pass', () => {
    const capture = buildOfficialProgram().commands.find((command) => command.name() === 'capture');
    const checkpoint = capture?.commands.find((command) => command.name() === 'checkpoint');
    const open = checkpoint?.commands.find((command) => command.name() === 'open');
    expect(open).toBeDefined();
    const help = open!.helpInformation();
    expect(help).toMatch(/Skip LLM evaluators without executing a provider/);
    expect(help).not.toMatch(/LLM evaluators to PASS/);
  });
});

// Coverage gap: a hardcoded `noLlm: false` in this adapter escapes
// every integration test
// because the test fixtures contain no LLM-bound evaluators that would
// surface the regression downstream. The unit test below pins the
// boolean translation directly so a future drift fails fast.
describe('makeCaptureFlagAdapter', () => {
  it('translates --no-llm (commander: opts.llm === false) into noLlm: true', async () => {
    const calls: Array<{ noLlm?: boolean }> = [];
    const adapter = makeCaptureFlagAdapter(async (opts) => {
      calls.push(opts);
    });
    await adapter({ llm: false });
    expect(calls).toHaveLength(1);
    expect(calls[0].noLlm).toBe(true);
  });

  it('absence of --no-llm (commander: opts.llm undefined) maps to noLlm: false', async () => {
    const calls: Array<{ noLlm?: boolean }> = [];
    const adapter = makeCaptureFlagAdapter(async (opts) => {
      calls.push(opts);
    });
    await adapter({});
    expect(calls[0].noLlm).toBe(false);
  });

  it('explicit --llm (opts.llm === true) maps to noLlm: false', async () => {
    const calls: Array<{ noLlm?: boolean }> = [];
    const adapter = makeCaptureFlagAdapter(async (opts) => {
      calls.push(opts);
    });
    await adapter({ llm: true });
    expect(calls[0].noLlm).toBe(false);
  });

  it('forwards the input opt unchanged', async () => {
    const calls: Array<{ input?: string; noLlm?: boolean }> = [];
    const adapter = makeCaptureFlagAdapter(async (opts) => {
      calls.push(opts);
    });
    await adapter({ input: '/tmp/x.json', llm: false });
    expect(calls[0]).toEqual({ input: '/tmp/x.json', noLlm: true });
  });
});

describe('strict numeric option parsing', () => {
  it('rejects a non-numeric --retention-days instead of coercing to NaN', async () => {
    const err = await parseExpectingFailure(['gc', '--retention-days', 'abc']);
    expect(err.code).toBe('commander.invalidArgument');
  });

  it('rejects trailing garbage on --retention-days', async () => {
    const err = await parseExpectingFailure(['gc', '--retention-days', '12abc']);
    expect(err.code).toBe('commander.invalidArgument');
  });

  it('rejects exponent notation on --retention-days', async () => {
    const err = await parseExpectingFailure(['gc', '--retention-days', '1e3']);
    expect(err.code).toBe('commander.invalidArgument');
  });

  it('rejects trailing garbage on eval run --checkpoint', async () => {
    const err = await parseExpectingFailure([
      'eval',
      'run',
      '--ref',
      'core/x',
      '--checkpoint',
      '3abc',
    ]);
    expect(err.code).toBe('commander.invalidArgument');
  });

  it('rejects zero and negatives where a checkpoint number is required', async () => {
    const zero = await parseExpectingFailure([
      'snapshots',
      'checkout',
      '--artifact',
      'a1',
      '--checkpoint',
      '0',
    ]);
    expect(zero.code).toBe('commander.invalidArgument');
    const negative = await parseExpectingFailure([
      'fingerprint',
      'show',
      '--artifact',
      'a1',
      '--checkpoint',
      '-2',
    ]);
    // Commander treats "-2" as an unknown flag before coercion runs; either
    // rejection path is a rejection, never a coerced number.
    expect(typeof negative.code).toBe('string');
  });
});

describe('oversized digit-only literals', () => {
  it('rejects a digit string that would overflow to a non-safe integer', async () => {
    const oversized = '9'.repeat(400);
    const retention = await parseExpectingFailure(['gc', '--retention-days', oversized]);
    expect(retention.code).toBe('commander.invalidArgument');
    const checkpoint = await parseExpectingFailure([
      'fingerprint',
      'show',
      '--artifact',
      'a1',
      '--checkpoint',
      oversized,
    ]);
    expect(checkpoint.code).toBe('commander.invalidArgument');
  });
});
