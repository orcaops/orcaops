import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { SECRET_POSITIVES } from '@orcaops/evaluator-protocol/secret-corpus';
import { ArtifactLockLeaseLostError } from '@orcaops/storage';

import { toCloudErrorEnvelope } from './cloud-error-envelope.js';
import { type ArtifactCandidate, ErrorCodes, OrcaopsError } from './errors.js';
import {
  emitOk,
  toErrorEnvelope,
  writeErrorLine,
  writePipeFriendlyStdout,
  writeTerminalSafeStderr,
  writeTerminalSafeStdout,
} from './output.js';

/**
 * Second layer: a numeric/boolean-looking YAML scalar parses fine, then
 * fails the strict string schema as a Zod `invalid_type`. The input.ts
 * parse-error path can't catch that (the YAML parsed), so the hint is added
 * here, in the ZodError → envelope mapping.
 */
const JWT =
  'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';

describe('toErrorEnvelope — YAML coercion hint', () => {
  function zodErr(fn: () => unknown): unknown {
    try {
      fn();
    } catch (e) {
      return e;
    }
    throw new Error('expected a ZodError');
  }

  it('appends a quote/block-scalar hint when a string field received a coerced number', () => {
    const env = toErrorEnvelope(
      zodErr(() => z.object({ label: z.string() }).parse({ label: 123 }))
    );
    expect(env.error.code).toBe(ErrorCodes.INVALID_INPUT);
    expect(env.error.message).toContain('block scalar');
  });

  it('does NOT add the YAML hint for a non-string-type error (no over-firing)', () => {
    const env = toErrorEnvelope(zodErr(() => z.object({ n: z.number() }).parse({ n: 'x' })));
    expect(env.error.code).toBe(ErrorCodes.INVALID_INPUT);
    expect(env.error.message).not.toContain('block scalar');
  });

  it('a STRUCTURED value to a string field gets a plain-string message, not the block-scalar hint', () => {
    const env = toErrorEnvelope(
      zodErr(() =>
        z
          .object({ deferred_decisions: z.array(z.string()) })
          .parse({ deferred_decisions: [{ decision: 'x', reason: 'y' }] })
      )
    );
    expect(env.error.code).toBe(ErrorCodes.INVALID_INPUT);
    expect(env.error.message).toContain('structured value');
    expect(env.error.message).not.toContain('block scalar');
  });
});

describe('error envelopes scrub structured detail, not just the message', () => {
  function candidate(over: Partial<ArtifactCandidate> = {}): ArtifactCandidate {
    return {
      id: '019f0000-0000-7000-8000-000000000001',
      label: 'deploy',
      task: 'ship it',
      state: 'active',
      checkpoint_count: 1,
      last_activity_at: '2026-01-01T00:00:00.000Z',
      created_by_session_id: null,
      ...over,
    };
  }

  it('redacts a secret hiding in AMBIGUOUS_ARTIFACT candidate labels', () => {
    // The candidates carry user-authored `label` and `task` straight from a
    // captured plan, so scrubbing only the prose beside them leaves the
    // planted value in the envelope.
    const err = new OrcaopsError(ErrorCodes.AMBIGUOUS_ARTIFACT, 'two active artifacts', undefined, {
      candidates: [candidate({ label: `deploy ${JWT}` })],
    });
    const envelope = toErrorEnvelope(err);
    expect(JSON.stringify(envelope)).not.toContain(JWT);
  });

  it('redacts a secret split by complete terminal formatting in structured detail', () => {
    const token = 'ghp_0000000000000000000000000000000000000';
    const split = `${token.slice(0, 20)}\u001b[31m${token.slice(20)}`;
    const err = new OrcaopsError(ErrorCodes.AMBIGUOUS_ARTIFACT, 'two active artifacts', undefined, {
      candidates: [candidate({ label: split })],
    });

    const serialized = JSON.stringify(toErrorEnvelope(err));

    expect(serialized).toContain('[REDACTED_SECRET]');
    expect(serialized).not.toContain('[31m');
    expect(serialized).not.toContain(token);
  });

  it('caps a large candidate list without breaking the declared element type', () => {
    const many = Array.from({ length: 120 }, (_, i) =>
      candidate({ id: `id-${i}`, label: `l${i}` })
    );
    const err = new OrcaopsError(ErrorCodes.AMBIGUOUS_ARTIFACT, 'many', undefined, {
      candidates: many,
    });

    const envelope = toErrorEnvelope(err);

    const candidates = envelope.error.candidates ?? [];
    expect(candidates.length).toBeLessThan(many.length);
    // No type assertion here on purpose: every surviving element must satisfy
    // ArtifactCandidate, which a disclosure marker pushed into the array
    // would not. That marker is what a machine consumer chokes on.
    for (const c of candidates) {
      expect(typeof c.id).toBe('string');
      expect(typeof c.label).toBe('string');
    }
    expect(envelope.error.message).toContain('omitted');
  });

  it('leaves ordinary structured detail untouched', () => {
    const err = new OrcaopsError(ErrorCodes.INVALID_INPUT, 'bad input', 'artifact_id');
    const envelope = toErrorEnvelope(err) as unknown as { error: { path?: string } };
    expect(envelope.error.path).toBe('artifact_id');
  });

  it('discloses a non-empty cloud error removed entirely by terminal scrubbing', () => {
    for (const input of ['\u001b[31m', ' \u001b[31m']) {
      const envelope = toErrorEnvelope(toCloudErrorEnvelope(new Error(input)));
      expect(envelope.error.message).toBe('[diagnostic removed]');
    }
    expect(toErrorEnvelope(toCloudErrorEnvelope(new Error(''))).error.message).toBe('');
    expect(toErrorEnvelope(toCloudErrorEnvelope(new Error(' '))).error.message).toBe(' ');
  });

  it.each(SECRET_POSITIVES.map(({ name, sample }) => [name, sample] as const))(
    'redacts the shared %s shape from JSON error output',
    (_name, sample) => {
      const serialized = JSON.stringify(toErrorEnvelope(new Error(`upstream echoed ${sample}`)));
      expect(serialized).not.toContain(sample);
      expect(serialized).toContain('REDACTED');
    }
  );
});

describe('writeErrorLine', () => {
  // Human mode is the DEFAULT output mode, so a leak here is the common case,
  // not the edge one. Both modes must leave through the same scrubber.
  function capture(err: unknown): string {
    const written: string[] = [];
    const spy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk: string | Uint8Array) => {
        written.push(String(chunk));
        return true;
      });
    try {
      writeErrorLine(err);
    } finally {
      spy.mockRestore();
    }
    return written.join('');
  }

  it('discloses a lease loss that rode along as the failure cause', () => {
    const err = new Error('checkpoint close failed', {
      cause: new ArtifactLockLeaseLostError('artifact-1'),
    });
    const out = capture(err);
    // The operation error still leads; the concurrency violation follows it
    // instead of being dropped.
    expect(out.startsWith('Error: checkpoint close failed')).toBe(true);
    expect(out).toContain('note: ');
    expect(out).toContain('artifact-1');
    expect(out).toContain('another process may have run concurrently');
  });

  it('says nothing extra when the cause is not a lease loss', () => {
    const out = capture(new Error('checkpoint close failed', { cause: new Error('ENOSPC') }));
    expect(out).toBe('Error: checkpoint close failed\n');
  });

  it('scrubs a bearer token out of the stderr line', () => {
    const out = capture(new Error('upstream rejected: Authorization: Bearer sk-live-abcdef123456'));
    expect(out).not.toContain('sk-live-abcdef123456');
    expect(out.startsWith('Error: ')).toBe(true);
    expect(out.endsWith('\n')).toBe(true);
  });

  it('scrubs a token whose shape is split by a terminal control', () => {
    const esc = String.fromCharCode(0x1b);
    const token = 'ghp_0000000000000000000000000000000000000';
    const out = capture(new Error(`${token.slice(0, 20)}${esc}${token.slice(20)}`));

    expect(out).not.toContain(token);
    expect(out).toContain('[REDACTED_SECRET]');
    expect(out).not.toContain(esc);
  });

  it('scrubs an authored error, not just the generic branch', () => {
    // OrcaopsError echoes its message verbatim into the envelope, so it is
    // the branch that leaks if scrubbing is done per-branch instead of at the
    // single exit.
    const err = new OrcaopsError(ErrorCodes.INVALID_INPUT, `plan pinned with token ${JWT}`);
    const out = capture(err);
    expect(out).not.toContain(JWT);
    expect(out).toContain('plan pinned with token');
  });

  it('bounds an authored message that would otherwise be unbounded', () => {
    const err = new OrcaopsError(ErrorCodes.INVALID_INPUT, 'x'.repeat(20_000));
    const out = capture(err);
    expect(out.length).toBeLessThan(5_000);
    expect(out).toContain('[truncated]');
  });

  it('preserves an ordinary message unchanged when there is nothing to scrub', () => {
    expect(capture(new Error('no such artifact'))).toBe('Error: no such artifact\n');
  });

  it.each(SECRET_POSITIVES.map(({ name, sample }) => [name, sample] as const))(
    'redacts the shared %s shape from human error output',
    (_name, sample) => {
      const out = capture(new Error(`upstream echoed ${sample}`));
      expect(out).not.toContain(sample);
      expect(out).toContain('REDACTED');
    }
  );
});

describe('terminal-safe human output', () => {
  it.each([
    ['stdout', process.stdout, writeTerminalSafeStdout],
    ['stderr', process.stderr, writeTerminalSafeStderr],
  ] as const)('neutralizes controls written to %s', (_name, stream, write) => {
    const chunks: string[] = [];
    const spy = vi.spyOn(stream, 'write').mockImplementation((chunk: string | Uint8Array) => {
      chunks.push(String(chunk));
      return true;
    });
    try {
      write('before\u001b[2J\u009b2Jafter\u202ehidden');
    } finally {
      spy.mockRestore();
    }

    expect(chunks.join('')).toBe('beforeafterhidden');
  });

  it.each([
    [true, 'beforeafter'],
    [false, 'before\u001b[2Jafter'],
  ])('preserves pipe data only when stdout isTTY=%s', (isTTY, expected) => {
    const chunks: string[] = [];
    const originalIsTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: isTTY });
    const write = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: string | Uint8Array) => {
        chunks.push(String(chunk));
        return true;
      });
    try {
      writePipeFriendlyStdout('before\u001b[2Jafter');
    } finally {
      write.mockRestore();
      if (originalIsTTY === undefined) delete (process.stdout as { isTTY?: boolean }).isTTY;
      else Object.defineProperty(process.stdout, 'isTTY', originalIsTTY);
    }

    expect(chunks.join('')).toBe(expected);
  });

  it('writes non-UTF-8 pipe bytes without decoding them', () => {
    const chunks: Uint8Array[] = [];
    const originalIsTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: false });
    const write = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: string | Uint8Array) => {
        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
        return true;
      });
    try {
      writePipeFriendlyStdout(Buffer.from([0x80, 0xff]));
    } finally {
      write.mockRestore();
      if (originalIsTTY === undefined) delete (process.stdout as { isTTY?: boolean }).isTTY;
      else Object.defineProperty(process.stdout, 'isTTY', originalIsTTY);
    }

    expect(Buffer.concat(chunks)).toEqual(Buffer.from([0x80, 0xff]));
  });

  it('decodes and sanitizes byte input written to a terminal', () => {
    const chunks: string[] = [];
    const originalIsTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
    const write = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: string | Uint8Array) => {
        chunks.push(String(chunk));
        return true;
      });
    try {
      writePipeFriendlyStdout(Buffer.from('before\u001b[2Jafter'));
    } finally {
      write.mockRestore();
      if (originalIsTTY === undefined) delete (process.stdout as { isTTY?: boolean }).isTTY;
      else Object.defineProperty(process.stdout, 'isTTY', originalIsTTY);
    }

    expect(chunks.join('')).toBe('beforeafter');
  });

  it('does not make CSI parameter bytes complete a secret shape', () => {
    const prefix = `ghp_${'A'.repeat(25)}`;
    const hiddenSuffix = `${String.fromCharCode(0x9b)}0123456789m`;
    const completedToken = `${prefix}0123456789m`;
    const chunks: string[] = [];
    const write = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: string | Uint8Array) => {
        chunks.push(String(chunk));
        return true;
      });
    try {
      writeTerminalSafeStdout(`${prefix}${hiddenSuffix}`);
    } finally {
      write.mockRestore();
    }

    expect(chunks.join('')).toBe(prefix);
    expect(chunks.join('')).not.toContain(completedToken);
  });
});

describe('emitOk', () => {
  it('escapes C1 controls while preserving their JSON value', () => {
    const csi = String.fromCharCode(0x9b);
    const written: string[] = [];
    const spy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: string | Uint8Array) => {
        written.push(String(chunk));
        return true;
      });
    try {
      emitOk({ message: `before${csi}2Jafter` });
    } finally {
      spy.mockRestore();
    }

    const serialized = written.join('');
    expect(serialized).not.toContain(csi);
    expect(JSON.parse(serialized)).toEqual({ ok: true, message: `before${csi}2Jafter` });
  });
});
