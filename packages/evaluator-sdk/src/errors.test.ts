import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { safeExecute } from './errors.js';

describe('safeExecute', () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let stdout: string;
  let stderr: string;
  let priorExitCode: number | string | undefined;

  beforeEach(() => {
    stdout = '';
    stderr = '';
    priorExitCode = process.exitCode;
    process.exitCode = undefined;
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      stdout += String(chunk);
      return true;
    });
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      stderr += String(chunk);
      return true;
    });
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    process.exitCode = priorExitCode;
  });

  it('runs the function without intervention on the happy path', async () => {
    let ran = false;
    safeExecute(() => {
      ran = true;
    });
    // safeExecute fires-and-forgets via void IIFE; let the microtask drain.
    await new Promise((r) => setImmediate(r));
    expect(ran).toBe(true);
    expect(stdout).toBe('');
    expect(stderr).toBe('');
    expect(process.exitCode).toBeUndefined();
  });

  it('maps sync throws to stderr and a non-zero exit without authoring a verdict', async () => {
    safeExecute(() => {
      throw new Error('boom sync');
    });
    await new Promise((r) => setImmediate(r));
    expect(stdout).toBe('');
    expect(stderr).toContain('Evaluator crashed: boom sync');
    expect(process.exitCode).toBe(1);
  });

  it('maps async rejections to stderr and a non-zero exit', async () => {
    safeExecute(async () => {
      await Promise.resolve();
      throw new Error('boom async');
    });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(stdout).toBe('');
    expect(stderr).toContain('boom async');
    expect(process.exitCode).toBe(1);
  });

  it('handles non-Error throws by stringifying them', async () => {
    safeExecute(() => {
      throw 'string thrown';
    });
    await new Promise((r) => setImmediate(r));
    expect(stdout).toBe('');
    expect(stderr).toContain('string thrown');
    expect(process.exitCode).toBe(1);
  });
});
