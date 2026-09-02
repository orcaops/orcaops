import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTempRepo, type TempRepo } from '@orcaops/test-harness';

import { makeAgent } from '../support/test-agent.js';

/**
 * The `orcaops watch` delegation stub. The child bin is pinned via
 * `ORCAOPS_WATCH_BIN` (injected through the in-process agent's ALS env, which the
 * stub reads via getInvocationEnv()), so these run hermetically without the real
 * watch app installed.
 */
describe('orcaops watch — delegation stub', () => {
  let repo: TempRepo;
  let tmp: string;

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
    tmp = mkdtempSync(path.join(tmpdir(), 'orcaops-watch-stub-'));
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it('prints an install hint and exits non-zero when the watch bin is missing (ENOENT)', async () => {
    const agent = makeAgent({
      cwd: repo.path,
      env: { ORCAOPS_WATCH_BIN: path.join(tmp, 'does-not-exist') },
    });
    const result = await agent.runRaw(['watch', '--once']);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("could not find the 'orcaops-watch' binary");
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

  it('with no ORCAOPS_WATCH_BIN, falls through the sibling miss to a bare PATH lookup', async () => {
    // No override → resolveWatchBin derives the sibling of this process's argv[1]
    // (the vitest worker), which has no orcaops-watch neighbour, so it falls through
    // to the bare `orcaops-watch` PATH tier. PATH is pinned to an empty dir because
    // a pnpm/npx-run suite puts the workspace `node_modules/.bin` — which DOES
    // contain orcaops-watch — on PATH; without this the bare lookup resolves and
    // spawns the real Bun TUI, and the test hangs instead of asserting the hint.
    const agent = makeAgent({ cwd: repo.path, env: { PATH: tmp } });
    const result = await agent.runRaw(['watch', '--once']);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("could not find the 'orcaops-watch' binary");
  });
});
