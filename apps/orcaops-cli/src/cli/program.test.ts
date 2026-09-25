import { describe, expect, it, vi } from 'vitest';

import { CLOUD_HIDDEN_COMMANDS } from '@orcaops/adapters';
import { DEFAULT_CLOUD_BASE_URL } from '@orcaops/core';

import { buildProgram, makeCaptureFlagAdapter } from './program.js';
import { finishAction } from '../commands/finish.js';
import { runInInvocationContext } from '../lib/invocation-context.js';

vi.mock('../commands/finish.js', () => ({ finishAction: vi.fn(async () => undefined) }));

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
  it('keeps help choices aligned with accepted agent ids and digest output', () => {
    const program = buildOfficialProgram();
    const capture = program.commands.find((command) => command.name() === 'capture')!;
    const plan = capture.commands.find((command) => command.name() === 'plan')!;
    const seed = program.commands.find((command) => command.name() === 'seed')!;
    const digest = program.commands.find((command) => command.name() === 'digest')!;

    expect(plan.helpInformation()).toContain('antigravity-cli');
    expect(seed.helpInformation()).toContain('antigravity-cli');
    expect(digest.helpInformation()).toMatch(/print a\s+confirmation/);
    expect(digest.helpInformation()).not.toContain('in addition to stdout');
  });

  it('lets an agent name itself on every knowledge command that records or stamps who acted', () => {
    const knowledge = buildOfficialProgram().commands.find(
      (command) => command.name() === 'knowledge'
    )!;
    const at = (...names: string[]) =>
      names.reduce(
        (command, name) => command.commands.find((child) => child.name() === name)!,
        knowledge
      );
    for (const names of [
      ['pause'],
      ['resume'],
      ['retry'],
      ['reopen'],
      ['reconsider', 'open'],
      ['reconsider', 'dispose'],
      ['assignment', 'open'],
      ['assignment', 'revoke'],
    ]) {
      expect([names.join(' '), at(...names).options.map((option) => option.long)]).toEqual([
        names.join(' '),
        expect.arrayContaining(['--invoked-by-agent']),
      ]);
    }
  });

  it('does not register the retired archive surface', () => {
    const program = buildOfficialProgram();

    expect(program.commands.some((command) => command.name() === 'archive')).toBe(false);
  });

  it('registers the history family with its four verbs, and previews by default', () => {
    const history = buildOfficialProgram().commands.find((command) => command.name() === 'history');
    expect(history).toBeDefined();
    expect(history!.commands.map((command) => command.name()).sort()).toEqual([
      'backups',
      'convert',
      'restore',
      'upgrade',
    ]);

    // Nothing here changes a database without the explicit flag, so every verb that can must
    // carry it and the read-only one must not.
    for (const [name, mutating] of [
      ['upgrade', true],
      ['restore', true],
      ['backups', false],
    ] as const) {
      const verb = history!.commands.find((command) => command.name() === name)!;
      expect([name, verb.options.some((option) => option.long === '--apply')]).toEqual([
        name,
        mutating,
      ]);
      expect([name, verb.options.some((option) => option.long === '--json')]).toEqual([name, true]);
    }
  });

  it('registers the knowledge processing family with every verb it offers and hides its worker', () => {
    const knowledge = buildOfficialProgram().commands.find(
      (command) => command.name() === 'knowledge'
    );
    expect(knowledge).toBeDefined();
    expect(knowledge!.commands.map((command) => command.name()).sort()).toEqual([
      'assess',
      'assignment',
      'consequences',
      'disable',
      'enable',
      'equivalence',
      'lookup',
      'observe',
      'pause',
      'reconsider',
      'reopen',
      'resume',
      'retry',
      'revoke',
      'show',
      'status',
      'worker',
    ]);
    const equivalence = knowledge!.commands.find((command) => command.name() === 'equivalence')!;
    expect(equivalence.commands.map((command) => command.name())).toEqual(['reject']);
    const reconsider = knowledge!.commands.find((command) => command.name() === 'reconsider')!;
    expect(reconsider.commands.map((command) => command.name()).sort()).toEqual([
      'dispose',
      'list',
      'open',
    ]);
    const assignment = knowledge!.commands.find((command) => command.name() === 'assignment')!;
    expect(assignment.commands.map((command) => command.name()).sort()).toEqual([
      'list',
      'open',
      'revoke',
    ]);
    // Ending a delegation says why: a revocation with no reason records nothing.
    expect(
      assignment.commands
        .find((command) => command.name() === 'revoke')!
        .options.some((option) => option.long === '--reason' && option.required)
    ).toBe(true);
    const pause = knowledge!.commands.find((command) => command.name() === 'pause')!;
    expect(pause.options.some((option) => option.long === '--reason' && option.required)).toBe(
      true
    );

    // The worker spends money under a recorded grant and is started by orcaops
    // itself; offering it in help would invite it to be typed.
    const visible = buildOfficialProgram()
      .createHelp()
      .visibleCommands(knowledge!)
      .map((command) => command.name());
    expect(visible).not.toContain('worker');

    const enable = knowledge!.commands.find((command) => command.name() === 'enable')!;
    const help = enable.helpInformation().replace(/\s+/g, ' ');
    expect(help).toContain('typed confirmation at a terminal');
    expect(help).toContain('the grant covers captures from now on');
  });

  it('offers no flag that would grant processing consent without a person', () => {
    const knowledge = buildOfficialProgram().commands.find(
      (command) => command.name() === 'knowledge'
    )!;
    const flags = knowledge.commands.flatMap((command) =>
      command.options.map((option) => option.long)
    );

    for (const bypass of ['--yes', '--force', '--non-interactive', '--no-confirm']) {
      expect(flags, bypass).not.toContain(bypass);
    }
  });

  it('documents ranked provenance, result limits, and JSON detail expansion', () => {
    const why = buildOfficialProgram().commands.find((command) => command.name() === 'why');
    expect(why).toBeDefined();
    const help = why!.helpInformation().replace(/\s+/g, ' ');
    expect(help).toContain('Find ranked provenance for <file>');
    expect(help).toContain('attribute <file>:<line>');
    expect(help).toContain('--all Default to 1,000 results; processing budgets still apply');
    expect(help).toContain(
      '--details Inspect one exact candidate under a 16 KiB response allowance'
    );
    expect(help).toContain(
      '--view <view> rationale: show explanations under a 32 KiB response allowance'
    );
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
    // The knowledge worker is hidden whatever the cloud gate says: it is
    // started by orcaops, never typed, and its visibility has nothing to do
    // with credentials.
    const ALWAYS_HIDDEN = ['knowledge worker'];

    it('hides exactly the shared hidden-command list without credentials', async () => {
      const hidden = commandPaths(await programWithCloud(false))
        .filter((c) => c.hidden)
        .map((c) => c.path)
        .sort();
      expect(hidden).toEqual([...CLOUD_HIDDEN_COMMANDS, ...ALWAYS_HIDDEN].sort());
    });

    it('hides only the worker with credentials', async () => {
      expect(
        commandPaths(await programWithCloud(true))
          .filter((c) => c.hidden)
          .map((c) => c.path)
      ).toEqual(ALWAYS_HIDDEN);
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
        commandPaths(buildProgram({ cloudBaseUrl: DEFAULT_CLOUD_BASE_URL }))
          .filter((c) => c.hidden)
          .map((c) => c.path)
      );
      expect(hidden).toEqual(ALWAYS_HIDDEN);
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

  it('--no-agents-md help states when unattended init adds the block', () => {
    const init = buildOfficialProgram().commands.find((command) => command.name() === 'init');
    expect(init).toBeDefined();
    const description = init!.options.find(
      (option) => option.long === '--no-agents-md'
    )?.description;
    expect(description).toBeDefined();
    expect(description).toMatch(/project or global/);
    expect(description).toMatch(/personal scope never adds one/);
    expect(description).toMatch(/session hooks/);
    expect(description).toMatch(/already has an instruction file/);
    // Unattended init writes the block under project and global scope, so the
    // flag is no longer describing the default.
    expect(description).not.toMatch(/the default for unattended init/);
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

  it('offers --no-llm on capture summary', () => {
    const capture = buildOfficialProgram().commands.find((command) => command.name() === 'capture');
    const summary = capture?.commands.find((command) => command.name() === 'summary');

    expect(summary).toBeDefined();
    expect(summary!.helpInformation().replace(/\s+/g, ' ')).toContain(
      '--no-llm Do not use an LLM to process this captured summary'
    );
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

describe('finish --no-llm wiring', () => {
  it('passes noLlm: true to the finish action when --no-llm is given', async () => {
    vi.mocked(finishAction).mockClear();
    await buildOfficialProgram().parseAsync(['finish', '--no-llm', '--input', '-'], {
      from: 'user',
    });
    expect(finishAction).toHaveBeenCalledWith({ input: '-', noLlm: true });
  });

  it('passes noLlm: false to the finish action without the flag', async () => {
    vi.mocked(finishAction).mockClear();
    await buildOfficialProgram().parseAsync(['finish', '--input', '-'], { from: 'user' });
    expect(finishAction).toHaveBeenCalledWith({ input: '-', noLlm: false });
  });
});

describe('strict numeric option parsing', () => {
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

describe('gc options', () => {
  it('rejects the retired age-based cleanup option', async () => {
    const error = await parseExpectingFailure(['gc', '--retention-days', '30']);
    expect(error.code).toBe('commander.unknownOption');
  });
});
