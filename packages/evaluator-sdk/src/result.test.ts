import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { info, pass, violation, writeResult } from './result.js';

describe('envelope constructors', () => {
  it('pass() builds a pass-verdict envelope with the schema literal', () => {
    const env = pass('PASS\n\nall good');
    expect(env).toEqual({
      schema: 'orcaops.evaluator_result/v1',
      verdict: 'pass',
      body: 'PASS\n\nall good',
    });
  });

  it('violation() builds a violation-verdict envelope', () => {
    const env = violation('VIOLATION\n\nfound 3 issues');
    expect(env.verdict).toBe('violation');
    expect(env.body).toContain('found 3 issues');
  });

  it('info() builds an info-verdict envelope', () => {
    const env = info('INFO\n\nfyi');
    expect(env.verdict).toBe('info');
  });

  it('attaches raw + metrics when provided', () => {
    const env = pass('PASS\n\nok', { raw: { count: 3 }, metrics: { files_scanned: 42 } });
    expect(env.raw).toEqual({ count: 3 });
    expect(env.metrics).toEqual({ files_scanned: 42 });
  });

  it('omits raw + metrics when not provided (no `raw: undefined` keys)', () => {
    const env = pass('PASS');
    expect('raw' in env).toBe(false);
    expect('metrics' in env).toBe(false);
  });
});

describe('writeResult', () => {
  let writeSpy: ReturnType<typeof vi.spyOn>;
  let captured: string;

  beforeEach(() => {
    captured = '';
    writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      captured += String(chunk);
      return true;
    });
  });

  afterEach(() => {
    writeSpy.mockRestore();
  });

  it('writes the JSON envelope to stdout as one chunk', () => {
    writeResult(pass('PASS\n\nok'));
    expect(captured).toBe(
      JSON.stringify({
        schema: 'orcaops.evaluator_result/v1',
        verdict: 'pass',
        body: 'PASS\n\nok',
      })
    );
  });

  it('round-trips through schema validation before writing', () => {
    // Constructing via the helper produces a schema-valid envelope;
    // writeResult must not modify it.
    const env = violation('VIOLATION\n\nbad', { metrics: { errors: 1 } });
    writeResult(env);
    const parsed = JSON.parse(captured);
    expect(parsed.verdict).toBe('violation');
    expect(parsed.metrics.errors).toBe(1);
  });

  it('throws on a malformed envelope (schema validation gate)', () => {
    // Bypass the constructor to inject a bad shape.
    expect(() =>
      writeResult({
        schema: 'orcaops.evaluator_result/v1',

        verdict: 'not-a-verdict' as any,
        body: 'x',
      })
    ).toThrow();
  });
});
