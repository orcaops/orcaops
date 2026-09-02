import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTempRepo, type TempRepo } from '@orcaops/test-harness';

import { makeAgent } from '../support/test-agent.js';

/**
 * ORCAOPS_CLOUD_FEATURES is the support knob that ships in the public binary:
 * `1` forces the gate open, `0` forces it shut, overriding real detection.
 * Forced-open commands must fail like a logged-out session, never crash.
 */
describe('the forced-gate knob', () => {
  let repo: TempRepo;
  let configHome: string;

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
    configHome = await mkdtemp(path.join(tmpdir(), 'orcaops-force-'));
    await makeAgent({ cwd: repo.path, env: { ORCAOPS_CONFIG_HOME: configHome } }).runRaw([
      'init',
      '--scope',
      'project',
      '--json',
      '--no-llm',
      '--install-agent',
      'claude-code',
    ]);
  });
  afterEach(async () => {
    await repo.cleanup();
    await rm(configHome, { recursive: true, force: true });
  });

  it('forced open without credentials fails cleanly, not loudly', async () => {
    const a = makeAgent({
      cwd: repo.path,
      env: { ORCAOPS_CONFIG_HOME: configHome, ORCAOPS_CLOUD_FEATURES: '1' },
    });
    const help = await a.runRaw(['--help']);
    expect(help.stdout).toMatch(/^\s+whoami\s/m);

    // The revealed command reports an honest disconnected state — no crash,
    // no cryptic error.
    const res = await a.runRaw(['whoami', '--json']);
    expect(res.exitCode).toBe(0);
    const env = JSON.parse(res.stdout) as {
      ok: boolean;
      state?: { kind: string; reason?: string };
    };
    expect(env.ok).toBe(true);
    expect(env.state?.kind).toBe('not_connected');
    expect(env.state?.reason).toBe('no_credentials');
  });

  it('forced shut hides the surface even with credentials on disk', async () => {
    await writeFile(
      path.join(configHome, 'credentials.json'),
      JSON.stringify({
        'https://cloud.example': {
          v: 1,
          loginMethod: 'oauth',
          baseUrl: 'https://cloud.example',
          userId: 'u',
          orgId: 'o',
          orgName: null,
          orgSlug: null,
          email: 'a@b.c',
          accessToken: 'at',
          refreshToken: 'rt',
          expiresAt: Math.floor(Date.now() / 1000) + 3600,
        },
      }),
      { mode: 0o600 }
    );
    const help = await makeAgent({
      cwd: repo.path,
      env: { ORCAOPS_CONFIG_HOME: configHome, ORCAOPS_CLOUD_FEATURES: '0' },
    }).runRaw(['--help']);
    expect(help.stdout).not.toMatch(/^\s+whoami\s/m);
    expect(help.stdout).not.toMatch(/^\s+plan\s/m);
  });
});
