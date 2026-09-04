import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTempRepo, type TempRepo } from '@orcaops/test-harness';

import { makeAgent } from '../support/test-agent.js';

/**
 * The `orcaops watch` launcher. The workspace CLI carries no platform pins, so
 * the child bin can be pinned via `ORCAOPS_WATCH_BIN` (injected through the
 * in-process agent's ALS env, which the launcher reads via getInvocationEnv())
 * and these run hermetically without a compiled companion installed.
 */
describe('orcaops watch launcher', () => {
  let repo: TempRepo;
  let tmp: string;

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
    tmp = mkdtempSync(path.join(tmpdir(), 'orcaops-watch-launcher-'));
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it('names the reinstall command and exits 127 when the override cannot be started', async () => {
    const agent = makeAgent({
      cwd: repo.path,
      env: { ORCAOPS_WATCH_BIN: path.join(tmp, 'does-not-exist') },
    });
    const result = await agent.runRaw(['watch', '--once']);
    expect(result.exitCode).toBe(127);
    expect(result.stderr).toContain('could not start');
    expect(result.stderr).toContain('npm i -g @orcaops/cli');
  });

  it('re-forwards --root to the child as ORCAOPS_ROOT', async () => {
    const record = path.join(tmp, 'root.txt');
    const script = path.join(tmp, 'fake-watch.sh');
    writeFileSync(script, `#!/bin/sh\nprintf '%s' "\${ORCAOPS_ROOT:-<unset>}" > "${record}"\n`);
    chmodSync(script, 0o755);

    const agent = makeAgent({ cwd: repo.path, env: { ORCAOPS_WATCH_BIN: script } });
    const result = await agent.runRaw(['watch', '--root', '/tmp/xyz', '--once']);

    expect(result.exitCode).toBe(0);
    // --root was consumed by commander and re-forwarded via the child's env,
    // NOT left in the pass-through args.
    expect(readFileSync(record, 'utf8')).toBe('/tmp/xyz');
  });

  it('propagates the child process exit code', async () => {
    const script = path.join(tmp, 'exit3.sh');
    writeFileSync(script, '#!/bin/sh\nexit 3\n');
    chmodSync(script, 0o755);

    const agent = makeAgent({ cwd: repo.path, env: { ORCAOPS_WATCH_BIN: script } });
    const result = await agent.runRaw(['watch', '--once']);
    expect(result.exitCode).toBe(3);
  });

  it('with no ORCAOPS_WATCH_BIN, reaches the workspace app and refuses to render without a terminal', async () => {
    // The workspace CLI has no platform pins, so resolution falls to the dev
    // tier: the @orcaops/watch app's built dist/main.js under Bun. The harness
    // has no TTY on either end, so the launcher must refuse before spawning
    // anything — otherwise the real TUI would start and the test would hang.
    const agent = makeAgent({ cwd: repo.path, env: { PATH: tmp } });
    const result = await agent.runRaw(['watch', '--once']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('needs an interactive terminal');
  });
});
