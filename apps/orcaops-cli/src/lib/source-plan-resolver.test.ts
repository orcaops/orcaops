import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os, { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { sourcePlanCacheDir, writePullCacheRecord } from '@orcaops/storage';

import { runInInvocationContext } from './invocation-context.js';
import { resolveSourcePlan } from './source-plan-resolver.js';
import { cloudRecord } from '../../tests/support/source-plan-test-helpers.js';

const sha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');
const FAKE_GH_TOKEN = 'ghp_ABCDEF1234567890abcdef1234567890ABCDEF';
const WARN_JWT =
  'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';

describe('resolveSourcePlan — cloud refs', () => {
  let repoRoot: string;
  beforeEach(async () => {
    repoRoot = await mkdtemp(path.join(tmpdir(), 'orcaops-resolver-'));
  });
  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  it('resolves an exactly-one cloud ref into a cloud pin', async () => {
    const rec = cloudRecord();
    await writePullCacheRecord(sourcePlanCacheDir(repoRoot), rec);
    const { pin, secretWarnings } = await resolveSourcePlan('cloud:ext-1@3', repoRoot, []);
    expect(pin).toEqual({
      source_ref: {
        kind: 'cloud',
        locator: 'ext-1',
        version: '3',
        base_url: 'https://cloud.example',
        org_id: 'org_1',
      },
      content: rec.body,
      hash: rec.content_hash,
      // The resolver never resolves a baseline for either kind (pure
      // file/cache-IO) — `capture plan` merges it for local pins.
      baseline: null,
    });
    expect(secretWarnings).toEqual([]);
  });

  it('hard-errors when the ref is not cached (miss → run plan pull)', async () => {
    await expect(resolveSourcePlan('cloud:ext-1@3', repoRoot, [])).rejects.toThrow(/plan pull/);
  });

  it('hard-errors when the ref is ambiguous across sessions', async () => {
    await writePullCacheRecord(sourcePlanCacheDir(repoRoot), cloudRecord({ org_id: 'org_a' }));
    await writePullCacheRecord(sourcePlanCacheDir(repoRoot), cloudRecord({ org_id: 'org_b' }));
    await expect(resolveSourcePlan('cloud:ext-1@3', repoRoot, [])).rejects.toThrow(/[Aa]mbiguous/);
  });

  it('rejects a non-integer / non-positive / malformed cloud version', async () => {
    for (const ref of ['cloud:ext-1@abc', 'cloud:ext-1@1.5', 'cloud:ext-1@0', 'cloud:ext-1@']) {
      await expect(resolveSourcePlan(ref, repoRoot, [])).rejects.toThrow(
        /Invalid cloud source-plan ref/
      );
    }
  });

  it('rejects hardened-regex violations: leading-zero, whitespace id, zero, unsafe magnitude', async () => {
    for (const ref of [
      'cloud:ext@007', // leading zero
      'cloud:ext 1@3', // whitespace in externalId
      'cloud:ext@0', // zero version
      'cloud:ext@9007199254740993', // > Number.MAX_SAFE_INTEGER
    ]) {
      await expect(resolveSourcePlan(ref, repoRoot, [])).rejects.toThrow(
        /Invalid cloud source-plan ref/
      );
    }
  });

  it('rejects a whitespace-only cached body (cloud-side blank-anchor guard)', async () => {
    await writePullCacheRecord(sourcePlanCacheDir(repoRoot), cloudRecord({ body: '   \n  ' }));
    await expect(resolveSourcePlan('cloud:ext-1@3', repoRoot, [])).rejects.toThrow(/blank/i);
  });

  it('rejects a cached body carrying a forbidden control char instead of pinning it', async () => {
    // Hash-consistent but dirty (a C1 byte): asserted, never stripped — a
    // stripped body would no longer match its content-addressed hash, and a
    // pinned dirty body could never pass the wire assert at push.
    await writePullCacheRecord(
      sourcePlanCacheDir(repoRoot),
      cloudRecord({ body: 'clean prose\u0085dirty tail' })
    );
    await expect(resolveSourcePlan('cloud:ext-1@3', repoRoot, [])).rejects.toThrow(/U\+0085/);
  });

  it.each([
    {
      field: 'locator',
      record: { external_id: FAKE_GH_TOKEN },
      ref: `cloud:${FAKE_GH_TOKEN}@3`,
      path: 'source_ref.locator',
    },
    {
      field: 'base URL',
      record: { base_url: `https://cloud.example/${FAKE_GH_TOKEN}` },
      ref: 'cloud:ext-1@3',
      path: 'source_ref.base_url',
    },
    {
      field: 'organization id',
      record: { org_id: FAKE_GH_TOKEN },
      ref: 'cloud:ext-1@3',
      path: 'source_ref.org_id',
    },
  ])('refuses a secret-shaped cloud $field without cloud-content remediation', async (fixture) => {
    await writePullCacheRecord(sourcePlanCacheDir(repoRoot), cloudRecord(fixture.record));
    const error = await resolveSourcePlan(fixture.ref, repoRoot, []).then(
      () => null,
      (caught: unknown) =>
        caught as {
          code: string;
          message: string;
          details?: { secret_findings?: Array<{ path: string }> };
        }
    );

    expect(error).toMatchObject({
      code: 'SECRET_IN_PAYLOAD',
      details: { secret_findings: [expect.objectContaining({ path: fixture.path })] },
    });
    expect(error?.message).not.toContain('re-approve');
  });

  it('returns a warn-tier finding for cloud metadata', async () => {
    await writePullCacheRecord(
      sourcePlanCacheDir(repoRoot),
      cloudRecord({ base_url: `https://cloud.example/${WARN_JWT}` })
    );

    const resolved = await resolveSourcePlan('cloud:ext-1@3', repoRoot, []);
    expect(resolved.secretWarnings).toEqual([
      expect.objectContaining({
        path: 'source_ref.base_url',
        patterns: expect.arrayContaining(['jwt']),
      }),
    ]);
  });

  it.each([
    '68de8126-7b2f-4cf0-9f85-e5fcd83ac59a',
    '0123456789abcdef0123456789abcdef',
    'org_0123456789abcdef0123456789abcdef',
  ])('does not flag a normal organization identifier: %s', async (orgId) => {
    await writePullCacheRecord(sourcePlanCacheDir(repoRoot), cloudRecord({ org_id: orgId }));
    const resolved = await resolveSourcePlan('cloud:ext-1@3', repoRoot, []);
    expect(resolved.secretWarnings).toEqual([]);
  });
});

describe('resolveSourcePlan — local refs', () => {
  let repoRoot: string;
  beforeEach(async () => {
    repoRoot = await mkdtemp(path.join(tmpdir(), 'orcaops-resolver-'));
  });
  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  it('canonicalizes a relative ref against the invocation cwd → repo-relative locator', async () => {
    const nested = path.join(repoRoot, 'docs', 'plans');
    await mkdir(nested, { recursive: true });
    await writeFile(path.join(nested, 'plan.md'), '# Plan\n\nbody', 'utf8');
    const { pin } = await runInInvocationContext({ cwd: nested }, () =>
      resolveSourcePlan('./plan.md', repoRoot, [])
    );
    expect(pin.source_ref).toEqual({
      kind: 'local',
      locator: path.join('docs', 'plans', 'plan.md'),
    });
    expect(pin.content).toBe('# Plan\n\nbody');
    expect(pin.hash).toBe(sha('# Plan\n\nbody'));
    // Pure file-IO for the local kind too: the resolver never resolves an
    // authoring baseline — `capture plan` merges it.
    expect(pin.baseline).toBeNull();
  });

  it('keeps an absolute out-of-repo locator (no ../ leak)', async () => {
    const outside = await mkdtemp(path.join(tmpdir(), 'orcaops-outside-'));
    const file = path.join(outside, 'plan.md');
    await writeFile(file, 'outside plan', 'utf8');
    try {
      const { pin } = await resolveSourcePlan(file, repoRoot, []);
      expect(pin.source_ref).toEqual({ kind: 'local', locator: file });
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('refuses a secret-shaped local locator', async () => {
    const outside = await mkdtemp(path.join(tmpdir(), `orcaops-${FAKE_GH_TOKEN}-`));
    const file = path.join(outside, 'plan.md');
    await writeFile(file, 'outside plan', 'utf8');
    try {
      await expect(resolveSourcePlan(file, repoRoot, [])).rejects.toMatchObject({
        code: 'SECRET_IN_PAYLOAD',
        details: {
          secret_findings: [expect.objectContaining({ path: 'source_ref.locator' })],
        },
      });
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('fails loud on a missing file', async () => {
    await expect(
      runInInvocationContext({ cwd: repoRoot }, () => resolveSourcePlan('./nope.md', repoRoot, []))
    ).rejects.toThrow(/not found/);
  });

  it('expands ~ against the home directory', async () => {
    const fakeHome = await mkdtemp(path.join(tmpdir(), 'orcaops-home-'));
    const homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);
    try {
      await writeFile(path.join(fakeHome, 'tilde-plan.md'), '# home plan', 'utf8');
      const { pin } = await runInInvocationContext({ cwd: repoRoot }, () =>
        resolveSourcePlan('~/tilde-plan.md', repoRoot, [])
      );
      expect(pin.content).toBe('# home plan');
      expect(pin.source_ref.kind).toBe('local');
    } finally {
      homedirSpy.mockRestore();
      await rm(fakeHome, { recursive: true, force: true });
    }
  });

  it('falls back to repo-root-relative when the cwd-relative path misses', async () => {
    // The agent runs from a subdirectory but passes a repo-root-relative path.
    const sub = path.join(repoRoot, 'apps', 'web');
    await mkdir(sub, { recursive: true });
    const plans = path.join(repoRoot, 'docs', 'plans');
    await mkdir(plans, { recursive: true });
    await writeFile(path.join(plans, 'slice.md'), '# root-relative plan', 'utf8');

    const { pin } = await runInInvocationContext({ cwd: sub }, () =>
      resolveSourcePlan('docs/plans/slice.md', repoRoot, [])
    );
    expect(pin.content).toBe('# root-relative plan');
    expect(pin.source_ref).toEqual({
      kind: 'local',
      locator: path.join('docs', 'plans', 'slice.md'),
    });
  });

  it('collapses an absolute path under the repo to a repo-relative locator', async () => {
    const docs = path.join(repoRoot, 'docs');
    await mkdir(docs, { recursive: true });
    const abs = path.join(docs, 'abs-plan.md');
    await writeFile(abs, '# absolute under repo', 'utf8');
    const { pin } = await resolveSourcePlan(abs, repoRoot, []);
    expect(pin.source_ref).toEqual({ kind: 'local', locator: path.join('docs', 'abs-plan.md') });
  });

  it('reports a directory ref with an explicit is-a-directory error', async () => {
    const dir = path.join(repoRoot, 'docs', 'plans');
    await mkdir(dir, { recursive: true });
    await expect(
      runInInvocationContext({ cwd: repoRoot }, () => resolveSourcePlan('docs/plans', repoRoot, []))
    ).rejects.toThrow(/is a directory, not a file/);
  });

  it('suggests same-basename files under the repo on a final miss, excluding node_modules', async () => {
    for (const dir of ['docs/plans', 'archive', 'node_modules/pkg']) {
      const d = path.join(repoRoot, dir);
      await mkdir(d, { recursive: true });
      await writeFile(path.join(d, 'slice-plan.md'), '# candidate', 'utf8');
    }
    const err = await runInInvocationContext({ cwd: repoRoot }, () =>
      resolveSourcePlan('./missing-dir/slice-plan.md', repoRoot, [])
    ).then(
      () => null,
      (e: Error) => e
    );
    expect(err).not.toBeNull();
    expect(err?.message).toContain('did you mean');
    expect(err?.message).toContain(path.join('docs', 'plans', 'slice-plan.md'));
    expect(err?.message).toContain(path.join('archive', 'slice-plan.md'));
    expect(err?.message).not.toContain('node_modules');
  });

  it('fails loud on an empty file', async () => {
    await writeFile(path.join(repoRoot, 'empty.md'), '   \n', 'utf8');
    await expect(
      runInInvocationContext({ cwd: repoRoot }, () => resolveSourcePlan('./empty.md', repoRoot, []))
    ).rejects.toThrow(/empty/);
  });

  it('strips forbidden control chars from a LOCAL file BEFORE hashing (born clean)', async () => {
    const NUL = String.fromCharCode(0x00);
    await writeFile(path.join(repoRoot, 'dirty.md'), `# Plan${NUL}\n\nclean body`, 'utf8');
    const { pin } = await runInInvocationContext({ cwd: repoRoot }, () =>
      resolveSourcePlan('./dirty.md', repoRoot, [])
    );
    // The NUL is stripped, and the hash is over the CLEAN content — so the pin is
    // born clean and sha256(content) === hash holds locally + at the wire re-verify.
    expect(pin.content).toBe('# Plan\n\nclean body');
    expect(pin.hash).toBe(sha('# Plan\n\nclean body'));
  });

  it('fails loud when a local file is all forbidden control chars (strips to empty)', async () => {
    const NUL = String.fromCharCode(0x00);
    await writeFile(path.join(repoRoot, 'allnul.md'), `${NUL}${NUL}${NUL}`, 'utf8');
    await expect(
      runInInvocationContext({ cwd: repoRoot }, () =>
        resolveSourcePlan('./allnul.md', repoRoot, [])
      )
    ).rejects.toThrow(/empty/);
  });
});
