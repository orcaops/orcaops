import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { makeAgent } from '../support/test-agent.js';

/**
 * `eval schema` runs where an author actually is when they reach for it: a
 * directory that is not a git repository and has never seen `orcaops init`.
 * Every other assertion here rides on that cwd — a temp dir, deliberately NOT
 * `createTempRepo`.
 */
describe('orcaops eval schema', () => {
  let cwd: string;
  let agent: ReturnType<typeof makeAgent>;

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), 'orcaops-eval-schema-'));
    agent = makeAgent({ cwd });
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  const run = (args: string[]) => agent.runRaw(['eval', 'schema', ...args]);

  for (const kind of ['spec', 'manifest', 'result']) {
    it(`emits a JSON Schema for ${kind} with no repository and no state written`, async () => {
      const result = await run([kind]);

      expect(result.exitCode).toBe(0);
      const projected = JSON.parse(result.stdout) as Record<string, unknown>;
      expect(projected.type).toBe('object');
      expect(projected.$schema).toContain('json-schema.org');
      expect(projected.$comment).toContain('Structural projection only');
      expect(projected.$comment).toContain('authoritative');

      // No `.orcaops`, no config, no archive identity — the directory is
      // exactly as it was found.
      expect(await readdir(cwd)).toEqual([]);
    });
  }

  it('answers what the author WRITES, not what the loader fills in', async () => {
    const spec = JSON.parse((await run(['spec'])).stdout) as { required: string[] };
    expect(spec.required).toEqual(['schema', 'id', 'phase', 'severity', 'engine']);
    // Defaulted keys stay optional. `io: 'output'` would demand all of these.
    for (const filled of ['default_enabled', 'params', 'filters', 'resolution', 'fingerprint']) {
      expect(spec.required).not.toContain(filled);
    }
  });

  it('accepts --json as a no-op alias — the output is a schema either way', async () => {
    const bare = await run(['spec']);
    const flagged = await run(['spec', '--json']);
    expect(flagged.exitCode).toBe(0);
    expect(flagged.stdout).toBe(bare.stdout);
  });

  it('fails an unknown kind deterministically, naming the kinds that exist', async () => {
    const first = await run(['fixture']);
    expect(first.exitCode).toBe(1);
    expect(first.stdout).toContain('INVALID_INPUT');
    expect(first.stdout).toContain('spec');
    expect(first.stdout).toContain('manifest');
    expect(first.stdout).toContain('result');

    // Deterministic: same input, same bytes, same exit — no repo probe, no
    // clock, no discovery in the failure path.
    const second = await run(['fixture']);
    expect(second.exitCode).toBe(first.exitCode);
    expect(second.stdout).toBe(first.stdout);
    expect(await readdir(cwd)).toEqual([]);
  });

  it('--example prints a ready-to-paste file, not a schema', async () => {
    for (const kind of ['spec', 'manifest']) {
      const result = await run([kind, '--example']);
      expect(result.exitCode, kind).toBe(0);
      // YAML an author pastes, not JSON Schema they read.
      expect(result.stdout, kind).not.toContain('$schema');
      expect(result.stdout, kind).toContain('schema: orcaops.evaluator');
      // Comments are the point — a generator could not emit them.
      expect(result.stdout, kind).toContain('#');
      expect(await readdir(cwd), kind).toEqual([]);
    }
  });

  it('--example refuses a shape nobody hand-writes, and says what builds it', async () => {
    const result = await run(['result', '--example']);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('INVALID_INPUT');
    expect(result.stdout).toContain('violation()');
    expect(result.stdout).toContain('spec, manifest');
    // `result` is still a valid kind WITHOUT --example.
    expect((await run(['result'])).exitCode).toBe(0);
  });

  it('is byte-stable across runs, so a checked-in projection has no churn', async () => {
    const first = await run(['manifest']);
    const second = await run(['manifest']);
    expect(second.stdout).toBe(first.stdout);
  });
});
