import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FileStore } from '@orcaops/core';

import { authStateAction } from './auth-state.js';

describe('orcaops auth-state', () => {
  let dir: string;
  let store: FileStore;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let originalExit: typeof process.exit;
  let exitCalled: number | null = null;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'orcaops-auth-state-e2e-'));
    store = new FileStore({ dir });
    exitCalled = null;
    originalExit = process.exit;
    Object.defineProperty(process, 'exit', {
      value: ((code?: number) => {
        exitCalled = code ?? 0;
        throw new Error(`process.exit(${code ?? 0})`);
      }) as never,
      configurable: true,
      writable: true,
    });
    vi.spyOn(await import('@orcaops/core'), 'resolveCredentialStore').mockReturnValue(store);
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    Object.defineProperty(process, 'exit', {
      value: originalExit,
      configurable: true,
      writable: true,
    });
    vi.restoreAllMocks();
  });

  function lastEmittedJson(): { ok: boolean; baseUrl: string; state: { kind: string } } {
    const out = stdoutSpy.mock.calls.flat().join('');
    return JSON.parse(out) as { ok: boolean; baseUrl: string; state: { kind: string } };
  }

  it('emits not_connected JSON when the store is empty', async () => {
    await authStateAction({ baseUrl: 'https://api.test', json: true });
    const parsed = lastEmittedJson();
    expect(parsed.ok).toBe(true);
    expect(parsed.state.kind).toBe('not_connected');
  });

  it('emits connected JSON for a fresh credential blob', async () => {
    store.write('https://api.test', {
      v: 1,
      loginMethod: 'oauth',
      baseUrl: 'https://api.test',
      userId: 'usr_a',
      orgId: 'org_a',
      orgName: 'Acme',
      orgSlug: 'acme',
      email: 'a@test',
      accessToken: 'eyJ.fake',
      refreshToken: 'rt_a',
      expiresAt: Math.floor(Date.now() / 1000) + 1800,
    });
    await authStateAction({ baseUrl: 'https://api.test', json: true });
    const parsed = lastEmittedJson();
    expect(parsed.state.kind).toBe('connected');
  });

  it('emits expired JSON when the token is past skew', async () => {
    store.write('https://api.test', {
      v: 1,
      loginMethod: 'oauth',
      baseUrl: 'https://api.test',
      userId: 'usr_e',
      orgId: 'org_e',
      orgName: 'Old',
      orgSlug: null,
      email: 'e@test',
      accessToken: 'eyJ.fake',
      refreshToken: 'rt_e',
      expiresAt: Math.floor(Date.now() / 1000) - 600,
    });
    await authStateAction({ baseUrl: 'https://api.test', json: true });
    const parsed = lastEmittedJson();
    expect(parsed.state.kind).toBe('expired');
  });

  it('targets production and reports not_connected with an empty store', async () => {
    await authStateAction({ json: true });
    const parsed = lastEmittedJson();
    expect(parsed.baseUrl).toBe('https://api.orcaops.ai');
    expect(parsed.state.kind).toBe('not_connected');
    expect(exitCalled).toBeNull();
  });

  it('--no-json emits human-readable text', async () => {
    store.write('https://api.test', {
      v: 1,
      loginMethod: 'oauth',
      baseUrl: 'https://api.test',
      userId: 'usr_h',
      orgId: 'org_h',
      orgName: 'Human',
      orgSlug: null,
      email: 'h@test',
      accessToken: 'eyJ.fake',
      refreshToken: 'rt_h',
      expiresAt: Math.floor(Date.now() / 1000) + 1800,
    });
    await authStateAction({ baseUrl: 'https://api.test', json: false });
    const out = stdoutSpy.mock.calls.flat().join('');
    expect(out).toContain('Connected (oauth)');
    expect(out).toContain('h@test for Human');
    expect(out).toMatch(/expires in 29 min|expires in 30 min/);
  });
});
