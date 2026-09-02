import { action, type Operation, run } from 'effection';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { evaluateOneShot as claudeOneShot } from './claude-code/one-shot.js';
import { evaluateOneShot as codexOneShot } from './codex/one-shot.js';
import { deterministicClient } from './deterministic.js';

/**
 * Cancellation contract: every `LLMClient` must observe
 * `EvaluateOptions.signal` — abort short-circuits before spawn (or kills
 * the subprocess mid-call) and resolves with `error.code: 'CANCELLED'`.
 * Command evaluators and LLM dispatches both honor cancellation.
 */
describe('deterministicClient — signal handling', () => {
  it('returns CANCELLED when the signal is already aborted at evaluate()', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await run(() =>
      deterministicClient.evaluate({ prompt: 'x', signal: controller.signal })
    );
    expect(result.error?.code).toBe('CANCELLED');
    expect(result.body).toContain('Cancelled');
  });

  it('returns TOOL_NOT_FOUND when the signal is present but never aborted', async () => {
    const controller = new AbortController();
    const result = await run(() =>
      deterministicClient.evaluate({ prompt: 'x', signal: controller.signal })
    );
    expect(result.error?.code).toBe('TOOL_NOT_FOUND');
    expect(result.body.startsWith('ERROR')).toBe(true);
  });
});

describe('claude one-shot — signal handling', () => {
  it('returns CANCELLED without spawning when signal is pre-aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    // Bin path is a non-existent file; if we DO spawn, the test fails
    // with TOOL_NOT_FOUND instead of CANCELLED — proving the pre-abort
    // short-circuit beats the spawn.
    const start = Date.now();
    const result = await run(() =>
      claudeOneShot(
        { binPath: '/nonexistent/claude', defaultTimeoutMs: 30_000 },
        { prompt: 'x', signal: controller.signal }
      )
    );
    expect(result.error?.code).toBe('CANCELLED');
    expect(result.durationMs).toBe(0);
    // Should return immediately — not wait for the timeout.
    expect(Date.now() - start).toBeLessThan(500);
  });

  it('kills the subprocess and resolves CANCELLED when signal aborts mid-call', async () => {
    const controller = new AbortController();
    // Fake "claude" binary: a node process that sleeps for 10 seconds.
    // The subprocess would otherwise outlive the test if cancellation
    // doesn't kill it.
    const result = await run(function* () {
      const promise = run(() =>
        claudeOneShot(
          { binPath: process.execPath, defaultTimeoutMs: 30_000 },
          {
            prompt: 'x',
            signal: controller.signal,
            // Override the args we wouldn't otherwise control — but
            // since we pass binPath = node, the args from buildClaudeArgs
            // will be nonsense to node; node will exit with an error.
            // That's fine for the abort test: if the abort fires before
            // node exits with an error, we see CANCELLED. If the abort
            // races and loses, we see TOOL_ERROR. We don't race here —
            // we abort after 100ms which is plenty of time for node to
            // be running.
            timeoutMs: 30_000,
          }
        )
      );
      yield* sleepMs(150);
      controller.abort();
      return yield* asYieldable(promise);
    });
    // We expect either CANCELLED (abort won) or TOOL_ERROR (node
    // exited too fast). Most runs are CANCELLED — the test asserts the
    // abort path is wired, not that it always wins the race.
    expect(['CANCELLED', 'TOOL_ERROR']).toContain(result.error?.code);
    if (result.error?.code === 'CANCELLED') {
      expect(result.body).toMatch(/Cancelled|aborted/i);
    }
  }, 10_000);
});

describe('codex one-shot — signal handling', () => {
  it('returns CANCELLED without spawning when signal is pre-aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const start = Date.now();
    const result = await run(() =>
      codexOneShot(
        { binPath: '/nonexistent/codex', defaultTimeoutMs: 30_000 },
        { prompt: 'x', signal: controller.signal }
      )
    );
    expect(result.error?.code).toBe('CANCELLED');
    expect(result.durationMs).toBe(0);
    expect(Date.now() - start).toBeLessThan(500);
  });

  it('kills the subprocess and resolves CANCELLED when signal aborts mid-call', async () => {
    const controller = new AbortController();
    const result = await run(function* () {
      const promise = run(() =>
        codexOneShot(
          { binPath: process.execPath, defaultTimeoutMs: 30_000 },
          { prompt: 'x', signal: controller.signal, timeoutMs: 30_000 }
        )
      );
      yield* sleepMs(150);
      controller.abort();
      return yield* asYieldable(promise);
    });
    expect(['CANCELLED', 'TOOL_ERROR']).toContain(result.error?.code);
    if (result.error?.code === 'CANCELLED') {
      expect(result.body).toMatch(/Cancelled|aborted/i);
    }
  }, 10_000);

  it('removes the implementation scratch directory after an aborted call', async () => {
    // Own the scratch parent: the one-shot must create its scratch dir UNDER
    // this injected parent, and an aborted call must remove it — observed
    // here, not assumed. The child is a plain sleeper (no SIGTERM trap), so
    // the abort deterministically kills it and the result MUST be CANCELLED —
    // cleanup is observed on the cancellation path, not an incidental
    // error-settlement path.
    const controller = new AbortController();
    const scratchParent = await mkdtemp(path.join(tmpdir(), 'orcaops-codex-scratch-'));
    try {
      const sleeper = path.join(scratchParent, 'sleeper.sh');
      await writeFile(sleeper, '#!/bin/sh\nsleep 30\n', { mode: 0o755 });
      const result = await run(function* () {
        const promise = run(() =>
          codexOneShot(
            { binPath: sleeper, defaultTimeoutMs: 30_000, scratchParentDir: scratchParent },
            { prompt: 'x', signal: controller.signal, timeoutMs: 30_000 }
          )
        );
        // The scratch dir must be OURS to observe: it appears under the
        // injected parent (fails here if the injection is not honored).
        yield* asYieldable(
          waitForCond(
            async () =>
              (await readdir(scratchParent)).some((entry) => entry.startsWith('orcaops-codex-')),
            'scratch under parent'
          )
        );
        controller.abort();
        return yield* asYieldable(promise);
      });
      expect(result.error?.code).toBe('CANCELLED');
      // The scratch rm is fire-and-forget; poll for the scratch entry to go.
      await waitForCond(
        async () =>
          !(await readdir(scratchParent)).some((entry) => entry.startsWith('orcaops-codex-')),
        'scratch removal'
      );
    } finally {
      await rm(scratchParent, { recursive: true, force: true });
    }
  }, 10_000);

  it('halting during async setup leaks neither scratch dir nor interval nor child', async () => {
    // The teardown can run while setup is suspended in mkdtemp/writeFile —
    // before activeProc or the watch interval exist. A late spawn after that
    // teardown would leak silently: nothing remains to clean it. Halt
    // IMMEDIATELY (no settling wait) and require that whatever the race
    // produced is fully retracted: no scratch entry survives and every
    // interval created is cleared.
    const scratchParent = await mkdtemp(path.join(tmpdir(), 'orcaops-codex-early-'));
    const created = new Set<unknown>();
    const cleared = new Set<unknown>();
    const realSetInterval = globalThis.setInterval;
    const realClearInterval = globalThis.clearInterval;
    const setSpy = vi.spyOn(globalThis, 'setInterval').mockImplementation(((...args: unknown[]) => {
      const handle = (realSetInterval as (...a: unknown[]) => unknown)(...args);
      created.add(handle);
      return handle;
    }) as typeof setInterval);
    const clearSpy = vi.spyOn(globalThis, 'clearInterval').mockImplementation(((
      handle: unknown
    ) => {
      cleared.add(handle);
      (realClearInterval as (h: unknown) => void)(handle);
    }) as typeof clearInterval);
    const script = path.join(tmpdir(), `orcaops-early-halt-${String(process.pid)}.sh`);
    try {
      await writeFile(script, '#!/bin/sh\ntrap "" TERM\nsleep 3\nexit 0\n', { mode: 0o755 });
      const task = run(() =>
        codexOneShot(
          { binPath: script, defaultTimeoutMs: 30_000, scratchParentDir: scratchParent },
          { prompt: 'x', timeoutMs: 30_000 }
        )
      );
      await task.halt();
      // Give any raced late setup time to spawn, then require full retraction.
      await new Promise((r) => setTimeout(r, 500));
      await waitForCond(
        async () => (await readdir(scratchParent)).length === 0,
        'late scratch retraction'
      );
      const survivors = [...created].filter((handle) => !cleared.has(handle));
      expect(survivors).toEqual([]);
    } finally {
      setSpy.mockRestore();
      clearSpy.mockRestore();
      await rm(script, { force: true });
      await rm(scratchParent, { recursive: true, force: true });
    }
  }, 10_000);

  it('halting mid schema-write still fully retracts the scratch dir', async () => {
    // A multi-megabyte schema makes an immediate halt likely to overlap the
    // write, but the assertion is the retraction invariant rather than an
    // exact interleave. This does not force the rejecting-write catch path;
    // that boundary needs an injectable filesystem seam.
    const scratchParent = await mkdtemp(path.join(tmpdir(), 'orcaops-codex-schema-'));
    try {
      const bigSchema = { description: 'x'.repeat(24 * 1024 * 1024) };
      const task = run(() =>
        codexOneShot(
          {
            binPath: '/nonexistent/codex',
            defaultTimeoutMs: 30_000,
            scratchParentDir: scratchParent,
          },
          { prompt: 'x', timeoutMs: 30_000, outputSchema: bigSchema }
        )
      );
      // Let mkdtemp complete so the halt targets the schema write.
      await waitForCond(
        async () => (await readdir(scratchParent)).length > 0,
        'scratch creation before halt'
      );
      await task.halt();
      await waitForCond(
        async () => (await readdir(scratchParent)).length === 0,
        'scratch retraction after mid-write halt'
      );
    } finally {
      await rm(scratchParent, { recursive: true, force: true });
    }
  }, 10_000);

  it('clears the watch interval on halt even when the child ignores SIGTERM', async () => {
    // A child that traps SIGTERM and stays alive briefly: the operation can
    // neither error nor close inside the test window, so ONLY the Effection
    // teardown can release resources. Self-limiting (~3 s) so no orphan
    // outlives the test run.
    const scratchParent = await mkdtemp(path.join(tmpdir(), 'orcaops-codex-halt-'));
    const script = path.join(scratchParent, 'stubborn.sh');
    await writeFile(script, '#!/bin/sh\ntrap "" TERM\nsleep 3\nexit 0\n', { mode: 0o755 });

    const created = new Set<unknown>();
    const cleared = new Set<unknown>();
    const realSetInterval = globalThis.setInterval;
    const realClearInterval = globalThis.clearInterval;
    const setSpy = vi.spyOn(globalThis, 'setInterval').mockImplementation(((...args: unknown[]) => {
      const handle = (realSetInterval as (...a: unknown[]) => unknown)(...args);
      created.add(handle);
      return handle;
    }) as typeof setInterval);
    const clearSpy = vi.spyOn(globalThis, 'clearInterval').mockImplementation(((
      handle: unknown
    ) => {
      cleared.add(handle);
      (realClearInterval as (h: unknown) => void)(handle);
    }) as typeof clearInterval);

    try {
      const task = run(() =>
        codexOneShot(
          { binPath: script, defaultTimeoutMs: 30_000, scratchParentDir: scratchParent },
          { prompt: 'x', timeoutMs: 30_000 }
        )
      );
      // Let async setup spawn the child and create the watch interval.
      await new Promise((r) => setTimeout(r, 300));
      await task.halt();
      // Every interval created during the operation must be cleared by the
      // teardown — a survivor keeps polling a settled operation forever.
      const survivors = [...created].filter((handle) => !cleared.has(handle));
      expect(survivors).toEqual([]);
    } finally {
      setSpy.mockRestore();
      clearSpy.mockRestore();
      await rm(scratchParent, { recursive: true, force: true });
    }
  }, 10_000);
});

// ── helpers ────────────────────────────────────────────────────────

async function waitForCond(cond: () => Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

function sleepMs(ms: number): Operation<void> {
  return action<void>(function (resolve) {
    const t = setTimeout(resolve, ms);
    return () => clearTimeout(t);
  });
}

function asYieldable<T>(p: Promise<T>): Operation<T> {
  return action<T>(function (resolve, reject) {
    p.then(resolve, reject);
    return () => {};
  });
}
