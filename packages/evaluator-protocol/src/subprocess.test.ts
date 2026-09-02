import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runBoundedSubprocess } from './subprocess.js';

/**
 * Lifecycle guarantees of the shared primitive.
 * Every test drives a real subprocess: the properties under test are all
 * about signals, process groups, and settlement, none of which survive
 * being mocked.
 */

const IS_WINDOWS = process.platform === 'win32';
let scratch: string;

beforeEach(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), 'orcaops-bounded-'));
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

/** A script that traps SIGTERM and keeps running — only SIGKILL stops it. */
async function writeSigtermIgnoringScript(): Promise<string> {
  const file = path.join(scratch, 'stubborn.sh');
  await writeFile(file, '#!/bin/bash\ntrap "" TERM\nwhile true; do sleep 0.05; done\n', {
    mode: 0o755,
  });
  return file;
}

function baseRequest(argv: string[]): Parameters<typeof runBoundedSubprocess>[0] {
  return {
    argv,
    cwd: scratch,
    env: { PATH: process.env.PATH ?? '' },
    timeoutMs: 30_000,
    maxOutputBytes: 1024 * 1024,
  };
}

describe('runBoundedSubprocess — escalation', () => {
  it.skipIf(IS_WINDOWS)(
    'SIGKILLs a SIGTERM-ignoring child within the grace and settles without waiting for stream closure',
    async () => {
      const script = await writeSigtermIgnoringScript();
      const started = Date.now();
      const result = await runBoundedSubprocess({
        ...baseRequest(['bash', script]),
        timeoutMs: 150,
        killGraceMs: 250,
      });
      const elapsed = Date.now() - started;

      expect(result.killed_reason).toBe('timeout');
      expect(result.hard_killed).toBe(true);
      expect(result.signal).toBe('SIGKILL');
      // timeout (150) + grace (250) = 400ms floor; the ceiling proves it did
      // not wait on anything else. A generous bound keeps this stable on a
      // loaded machine while still failing an unbounded wait.
      expect(elapsed).toBeGreaterThanOrEqual(350);
      expect(elapsed).toBeLessThan(5000);
    },
    15_000
  );

  it.skipIf(IS_WINDOWS)(
    'arms the hard-kill timer at the SIGTERM, not at spawn: a cancel escalates on its own grace',
    async () => {
      // The defect this pins: with the timer anchored to the timeout
      // deadline, a cancel at t=0 on a long-timeout process would wait the
      // whole timeout before SIGKILL. Here the timeout is 60s and the grace
      // 250ms — settling quickly is only possible if the grace is measured
      // from the SIGTERM.
      const script = await writeSigtermIgnoringScript();
      const controller = new AbortController();
      const started = Date.now();
      const pending = runBoundedSubprocess({
        ...baseRequest(['bash', script]),
        timeoutMs: 60_000,
        killGraceMs: 250,
        signal: controller.signal,
      });
      setTimeout(() => controller.abort(), 100);
      const result = await pending;
      const elapsed = Date.now() - started;

      expect(result.killed_reason).toBe('canceled');
      expect(result.hard_killed).toBe(true);
      expect(elapsed).toBeLessThan(5000);
    },
    15_000
  );

  it.skipIf(IS_WINDOWS)(
    'escalates an output-overflow kill on its own grace too',
    async () => {
      const file = path.join(scratch, 'flood.sh');
      // Floods stdout, then ignores SIGTERM — overflow must both kill and
      // escalate without waiting for the (long) timeout.
      await writeFile(
        file,
        '#!/bin/bash\ntrap "" TERM\nhead -c 200000 /dev/zero | tr "\\0" "x"\nwhile true; do sleep 0.05; done\n',
        { mode: 0o755 }
      );
      const started = Date.now();
      const result = await runBoundedSubprocess({
        ...baseRequest(['bash', file]),
        timeoutMs: 60_000,
        maxOutputBytes: 1024,
        killGraceMs: 250,
      });
      const elapsed = Date.now() - started;

      expect(result.killed_reason).toBe('output-too-large');
      expect(Buffer.byteLength(result.stdout, 'utf8')).toBeLessThanOrEqual(1024);
      expect(elapsed).toBeLessThan(5000);
    },
    15_000
  );

  it.skipIf(IS_WINDOWS)(
    'keeps the FIRST kill reason when a second cause genuinely follows',
    async () => {
      const file = path.join(scratch, 'flood-then-hang.sh');
      // Must IGNORE SIGTERM, or the overflow kill ends the process before the
      // timeout can fire and there is no second cause to be robust against.
      // The grace is long enough that the timeout (300ms) lands inside it.
      await writeFile(
        file,
        '#!/bin/bash\ntrap "" TERM\nhead -c 200000 /dev/zero | tr "\\0" "x"\nwhile true; do sleep 0.05; done\n',
        { mode: 0o755 }
      );
      const result = await runBoundedSubprocess({
        ...baseRequest(['bash', file]),
        timeoutMs: 300,
        maxOutputBytes: 1024,
        killGraceMs: 2000,
      });
      // Overflow fires within a few ms; the timeout then fires at 300ms while
      // the process is still alive, so escalate() really does re-enter.
      expect(result.killed_reason).toBe('output-too-large');
      expect(result.hard_killed).toBe(true);
    },
    20_000
  );
});

describe('runBoundedSubprocess — process group', () => {
  it.skipIf(IS_WINDOWS)(
    'kills descendants, not just the direct child',
    async () => {
      const marker = path.join(scratch, 'grandchild-alive.txt');
      const child = path.join(scratch, 'parent.sh');
      // The parent spawns a grandchild that outlives it unless the whole
      // process GROUP is signalled, and writes its pid where we can find it.
      await writeFile(
        child,
        [
          '#!/bin/bash',
          `bash -c 'echo $$ > ${marker}; while true; do sleep 0.05; done' &`,
          'trap "" TERM',
          'while true; do sleep 0.05; done',
        ].join('\n'),
        { mode: 0o755 }
      );

      const result = await runBoundedSubprocess({
        ...baseRequest(['bash', child]),
        timeoutMs: 300,
        killGraceMs: 250,
      });
      expect(result.killed_reason).toBe('timeout');

      const { readFile } = await import('node:fs/promises');
      const grandchildPid = Number((await readFile(marker, 'utf8')).trim());
      expect(Number.isInteger(grandchildPid)).toBe(true);

      // Give the group kill a moment to be reaped, then prove the grandchild
      // is gone. `kill -0` throws once the process no longer exists.
      await new Promise((r) => setTimeout(r, 300));
      let alive = true;
      try {
        execFileSync('kill', ['-0', String(grandchildPid)], { stdio: 'ignore' });
      } catch {
        alive = false;
      }
      expect(alive, `grandchild ${grandchildPid} survived the group kill`).toBe(false);
    },
    20_000
  );

  it.skipIf(IS_WINDOWS)(
    'does not resolve until a STUBBORN descendant is actually dead',
    async () => {
      // The boundary that matters: the caller acts on resolution (the runner
      // deletes the context dir and reports TIMEOUT), so the promise must not
      // resolve while a descendant of a process we killed is still running.
      // The leader here does NOT trap SIGTERM, so it dies at once and the
      // descendant is all that remains.
      const marker = path.join(scratch, 'stubborn-gc.txt');
      const parent = path.join(scratch, 'prompt-parent.sh');
      await writeFile(
        parent,
        [
          '#!/bin/bash',
          `bash -c 'trap "" TERM; echo $$ > ${marker}; while true; do sleep 0.05; done' &`,
          'while true; do sleep 0.05; done',
        ].join('\n'),
        { mode: 0o755 }
      );

      const result = await runBoundedSubprocess({
        ...baseRequest(['bash', parent]),
        timeoutMs: 300,
        killGraceMs: 400,
      });
      expect(result.killed_reason).toBe('timeout');
      // A SIGKILL really was delivered — to the descendant, at the end of the
      // grace — and that happened BEFORE this result existed.
      expect(result.hard_killed).toBe(true);

      const { readFile } = await import('node:fs/promises');
      const gcPid = Number((await readFile(marker, 'utf8')).trim());
      expect(Number.isInteger(gcPid)).toBe(true);

      // No sleep here on purpose: checked immediately after resolution.
      let alive = true;
      try {
        execFileSync('kill', ['-0', String(gcPid)], { stdio: 'ignore' });
      } catch {
        alive = false;
      }
      if (alive) {
        try {
          process.kill(gcPid, 'SIGKILL');
        } catch {
          /* cleanup only */
        }
      }
      expect(alive, `descendant ${gcPid} was still alive when the promise resolved`).toBe(false);
    },
    20_000
  );

  it.skipIf(IS_WINDOWS)(
    'does NOT cut the grace short: a descendant cleaning up on SIGTERM finishes',
    async () => {
      // The other half of the contract. Sweeping the group the moment the
      // leader exits would kill a descendant mid-cleanup, breaking the
      // SIGTERM-then-grace promise the pack-authoring docs make.
      const done = path.join(scratch, 'cleanup-finished.txt');
      const parent = path.join(scratch, 'graceful-parent.sh');
      await writeFile(
        parent,
        [
          '#!/bin/bash',
          `bash -c 'trap "sleep 0.3; echo done > ${done}; exit 0" TERM; while true; do sleep 0.05; done' &`,
          'while true; do sleep 0.05; done',
        ].join('\n'),
        { mode: 0o755 }
      );

      const started = Date.now();
      const result = await runBoundedSubprocess({
        ...baseRequest(['bash', parent]),
        timeoutMs: 200,
        killGraceMs: 5000, // far more than the 300ms cleanup needs
      });
      const elapsed = Date.now() - started;

      // The cleanup ran to completion rather than being cut short.
      const { access } = await import('node:fs/promises');
      await expect(
        access(done),
        'descendant was killed before finishing its SIGTERM cleanup'
      ).resolves.toBeUndefined();
      // Nothing needed killing, and we did not burn the whole grace waiting:
      // settlement follows the group draining, not the deadline.
      expect(result.hard_killed).toBe(false);
      expect(elapsed).toBeLessThan(3000);
    },
    20_000
  );
});

describe('runBoundedSubprocess — normal outcomes', () => {
  it('resolves cleanly for a fast successful child', async () => {
    const result = await runBoundedSubprocess({
      ...baseRequest(['node', '-e', 'process.stdout.write("hello")']),
    });
    expect(result.exit_code).toBe(0);
    expect(result.stdout).toBe('hello');
    expect(result.killed_reason).toBeNull();
    expect(result.hard_killed).toBe(false);
  }, 15_000);

  it('reports a non-zero exit without calling it a kill', async () => {
    const result = await runBoundedSubprocess({
      ...baseRequest(['node', '-e', 'process.exit(3)']),
    });
    expect(result.exit_code).toBe(3);
    expect(result.killed_reason).toBeNull();
  }, 15_000);

  it('reports a spawn failure rather than throwing', async () => {
    const result = await runBoundedSubprocess({
      ...baseRequest([path.join(scratch, 'does-not-exist')]),
    });
    expect(result.killed_reason).toBe('spawn-error');
    expect(result.spawn_error?.code).toBe('ENOENT');
  }, 15_000);

  it.each([
    ['command', { ...baseRequest(['invalid\u0000command']) }],
    [
      'environment',
      {
        ...baseRequest(['node', '-e', 'process.exit(0)']),
        env: { ...process.env, ORCAOPS_INVALID: 'value\u0000suffix' } as Record<string, string>,
      },
    ],
  ])('reports a synchronous %s spawn rejection without rejecting', async (_kind, request) => {
    const result = await runBoundedSubprocess(request);

    expect(result.killed_reason).toBe('spawn-error');
    expect(result.spawn_error?.message).toMatch(/null bytes|without null bytes/i);
    expect(result.termination_confirmed).toBe(true);
  });

  it('keeps a spawn failure authoritative when cancellation is already requested', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await runBoundedSubprocess({
      ...baseRequest([path.join(scratch, 'does-not-exist')]),
      signal: controller.signal,
    });
    expect(result.killed_reason).toBe('spawn-error');
    expect(result.spawn_error?.code).toBe('ENOENT');
    expect(result.termination_confirmed).toBe(true);
  }, 15_000);

  it('delivers cancellation requested before a successful spawn', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await runBoundedSubprocess({
      ...baseRequest(['node', '-e', 'setInterval(() => {}, 1000)']),
      signal: controller.signal,
    });
    expect(result.killed_reason).toBe('canceled');
    expect(result.spawn_error).toBeNull();
    expect(result.hard_killed).toBe(false);
    expect(result.termination_confirmed).toBe(true);
  }, 15_000);

  it('delivers stdin and counts the output cap in BYTES, not UTF-16 units', async () => {
    const result = await runBoundedSubprocess({
      ...baseRequest(['node', '-e', 'process.stdin.pipe(process.stdout)']),
      stdin: '€€€€', // 3 bytes each in UTF-8, 1 UTF-16 unit each
      maxOutputBytes: 7,
    });
    // 7 bytes cuts mid-character; the split sequence is trimmed rather than
    // decoded to a replacement character.
    expect(result.stdout).toBe('€€');
  }, 15_000);
});

describe('termination_confirmed', () => {
  it('is true for a process that exits on its own', async () => {
    const result = await runBoundedSubprocess({
      ...baseRequest(['node', '-e', 'process.stdout.write("ok")']),
    });
    expect(result.killed_reason).toBeNull();
    expect(result.termination_confirmed).toBe(true);
  }, 15_000);

  it.skipIf(IS_WINDOWS)(
    'is true for a killed process whose group drained',
    async () => {
      const script = await writeSigtermIgnoringScript();
      const result = await runBoundedSubprocess({
        ...baseRequest(['bash', script]),
        timeoutMs: 150,
        killGraceMs: 250,
      });
      expect(result.killed_reason).toBe('timeout');
      expect(result.hard_killed).toBe(true);
      // The drain was observed, not assumed.
      expect(result.termination_confirmed).toBe(true);
    },
    15_000
  );
});

describe('signals that cannot be delivered', () => {
  /** Pids of children our mocks prevented us from killing, cleaned up below. */
  let orphans: number[] = [];

  beforeEach(() => {
    orphans = [];
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // Mocked-away signals mean the real processes survived; reap them now
    // that the real syscalls are back, or they outlive the suite.
    for (const pid of orphans) {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        /* group already gone */
      }
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
  });

  /** Fail every GROUP signal/probe with `code`; single-pid calls pass through. */
  function failGroupSignals(code: string): void {
    const real = process.kill.bind(process);
    vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: string | number) => {
      if (pid < 0) {
        throw Object.assign(new Error(`mocked ${code}`), { code });
      }
      return real(pid, signal as NodeJS.Signals);
    }) as typeof process.kill);
  }

  it.skipIf(IS_WINDOWS)(
    'refuses to claim confirmation when the group probe returns EPERM rather than ESRCH',
    async () => {
      // EPERM means the group EXISTS but is not ours to signal. Reading that
      // as "drained" would report a completed termination over a live group.
      const script = await writeSigtermIgnoringScript();
      failGroupSignals('EPERM');
      const started = Date.now();
      const result = await runBoundedSubprocess({
        ...baseRequest(['bash', script]),
        timeoutMs: 150,
        killGraceMs: 200,
      });

      expect(result.killed_reason).toBe('timeout');
      // The direct-child fallback still landed, so a kill IS claimed...
      expect(result.hard_killed).toBe(true);
      // ...but the GROUP was never observed to drain, so completion is not.
      expect(result.termination_confirmed).toBe(false);
      expect(Date.now() - started).toBeLessThan(6000);
    },
    15_000
  );

  it.skipIf(IS_WINDOWS)(
    'the SAME run without the mock comes back confirmed',
    async () => {
      // The honest pair for the test above: identical script and timings,
      // real syscalls. Confirmation therefore tracks what actually happened
      // to the group rather than the presence of a mock. (Mocking ESRCH here
      // instead would fabricate "group gone" for a leader still running, and
      // would leave that leader orphaned.)
      const script = await writeSigtermIgnoringScript();
      const result = await runBoundedSubprocess({
        ...baseRequest(['bash', script]),
        timeoutMs: 150,
        killGraceMs: 200,
      });
      expect(result.killed_reason).toBe('timeout');
      expect(result.hard_killed).toBe(true);
      expect(result.termination_confirmed).toBe(true);
    },
    15_000
  );

  it.skipIf(IS_WINDOWS)(
    'keeps termination unconfirmed when failed kill delivery emits an error',
    async () => {
      // The hang this structure exists to prevent: with both the group signal
      // and the direct-child fallback failing, the leader never dies, so no
      // exit event ever arrives. Only the escalation timer can start the wait.
      // ChildProcess.prototype.kill is writable, so the fallback is mockable
      // without any production seam.
      const script = await writeSigtermIgnoringScript();
      const { ChildProcess } = await import('node:child_process');
      const realProcKill = process.kill.bind(process);
      let emittedKillError = false;
      vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: string | number) => {
        if (pid < 0) throw Object.assign(new Error('mocked EPERM'), { code: 'EPERM' });
        return realProcKill(pid, signal as NodeJS.Signals);
      }) as typeof process.kill);
      vi.spyOn(ChildProcess.prototype, 'kill').mockImplementation(function (
        this: InstanceType<typeof ChildProcess>
      ) {
        // Register for cleanup HERE, not after the await: under the very
        // regression this test catches, the await never returns and anything
        // recorded afterwards is never recorded at all — leaving a detached,
        // SIGTERM-ignoring child alive past the suite.
        if (this.pid !== undefined && !orphans.includes(this.pid)) orphans.push(this.pid);
        if (!emittedKillError) {
          emittedKillError = true;
          queueMicrotask(() => {
            this.emit(
              'error',
              Object.assign(new Error('mocked kill delivery failure'), { code: 'EPERM' })
            );
          });
        }
        return false; // delivery failed
      });

      const started = Date.now();
      const result = await runBoundedSubprocess({
        ...baseRequest(['bash', script]),
        timeoutMs: 150,
        killGraceMs: 200,
      });
      const elapsed = Date.now() - started;

      // It resolved at all — that is the blocker this pins.
      expect(elapsed).toBeLessThan(6000);
      expect(result.killed_reason).toBe('timeout');
      expect(result.spawn_error).toBeNull();
      // Nothing was delivered, so no kill is claimed and nothing is confirmed.
      expect(result.hard_killed).toBe(false);
      expect(result.termination_confirmed).toBe(false);
    },
    15_000
  );
});

describe('runBoundedSubprocess — output cap and secret containment', () => {
  const PEM_HEADER = '-----BEGIN RSA PRIVATE KEY-----';

  it.skipIf(IS_WINDOWS)('does not emit a key block the output cap severed', async () => {
    // The cap is what destroys the match, so redacting downstream cannot save
    // this: the closing delimiter is on the far side of the cut.
    const script = path.join(scratch, 'spill-key.sh');
    await writeFile(
      script,
      `#!/usr/bin/env bash\nprintf 'preamble\\n'\nprintf '%s\\n' '${PEM_HEADER}'\nfor i in $(seq 1 400); do printf 'MIIEowIBAAKCAQEAxTVc%s\\n' "$i"; done\nprintf '%s\\n' '-----END RSA PRIVATE KEY-----'\n`,
      { mode: 0o755 }
    );

    const result = await runBoundedSubprocess({
      ...baseRequest(['bash', script]),
      // Well inside the key body, so the block is cut open.
      maxOutputBytes: 512,
    });

    expect(result.stdout).toContain('preamble');
    expect(result.stdout).not.toContain(PEM_HEADER);
    expect(result.stdout).not.toContain('MIIEow');
  });

  it.skipIf(IS_WINDOWS)('leaves output that fits under the cap untouched', async () => {
    const script = path.join(scratch, 'small.sh');
    await writeFile(script, `#!/usr/bin/env bash\nprintf 'hello world\\n'\n`, { mode: 0o755 });

    const result = await runBoundedSubprocess({
      ...baseRequest(['bash', script]),
      maxOutputBytes: 4096,
    });

    expect(result.stdout).toBe('hello world\n');
  });
});

describe('escalation ordering around spawn', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.skipIf(IS_WINDOWS)(
    'signals nothing until the child has actually spawned',
    async () => {
      // An abort observed before spawn must wait for the 'spawn' event, not
      // merely for a microtask: the pid is assigned synchronously but the
      // child has not yet called setsid(), so a group signal sent in that
      // window can miss the group entirely and leave the child running.
      const { ChildProcess } = await import('node:child_process');
      const order: string[] = [];
      const realEmit = ChildProcess.prototype.emit as (
        this: unknown,
        event: string | symbol,
        ...args: unknown[]
      ) => boolean;
      const realChildKill = ChildProcess.prototype.kill;
      const realProcessKill = process.kill.bind(process);

      vi.spyOn(ChildProcess.prototype, 'emit').mockImplementation(function (
        this: InstanceType<typeof ChildProcess>,
        event: string | symbol,
        ...args: unknown[]
      ) {
        if (event === 'spawn') order.push('spawn');
        return realEmit.call(this, event, ...args);
      } as typeof ChildProcess.prototype.emit);
      vi.spyOn(ChildProcess.prototype, 'kill').mockImplementation(function (
        this: InstanceType<typeof ChildProcess>,
        signal?: NodeJS.Signals | number
      ) {
        order.push('kill');
        return realChildKill.call(this, signal);
      } as typeof ChildProcess.prototype.kill);
      vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: string | number) => {
        order.push('kill');
        return realProcessKill(pid, signal as NodeJS.Signals);
      }) as typeof process.kill);

      const controller = new AbortController();
      controller.abort();
      const result = await runBoundedSubprocess({
        ...baseRequest(['node', '-e', 'setInterval(() => {}, 1000)']),
        signal: controller.signal,
      });

      expect(result.killed_reason).toBe('canceled');
      expect(order).toContain('spawn');
      expect(order).toContain('kill');
      expect(order.indexOf('kill')).toBeGreaterThan(order.indexOf('spawn'));
    },
    15_000
  );
});
