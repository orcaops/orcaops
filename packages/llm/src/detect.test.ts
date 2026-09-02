import { run } from 'effection';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  commandExists,
  detectAvailableTool,
  probeProviderAvailability,
  selectDefaultProvider,
} from './detect.js';

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('commandExists', () => {
  it('returns true for a real binary that responds to --version', async () => {
    // `node` is guaranteed to exist (we're running on it).
    const found = await run(() => commandExists('node'));
    expect(found).toBe(true);
  });

  it('returns false for a binary that does not exist', async () => {
    const found = await run(() => commandExists('orcaops-definitely-not-installed-xyz'));
    expect(found).toBe(false);
  });
});

describe('detectAvailableTool', () => {
  // We can't assert a specific tool is present (depends on the dev's machine),
  // but the call must always resolve to one of the documented values.
  it('resolves to "claude" | "codex" | null', async () => {
    const tool = await run(() => detectAvailableTool());
    expect(['claude', 'codex', null]).toContain(tool);
  });

  it('probes each provider exactly once using its execution-path override', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'orcaops-provider-probe-'));
    cleanup.push(root);
    const counter = path.join(root, 'calls');
    const makeBin = async (name: string, exitCode: number): Promise<string> => {
      const bin = path.join(root, name);
      await writeFile(
        bin,
        `#!/bin/sh\nprintf '%s\\n' '${name}' >> '${counter}'\nexit ${exitCode}\n`,
        { mode: 0o755 }
      );
      return bin;
    };
    const claude = await makeBin('claude-probe', 0);
    const codex = await makeBin('codex-probe', 1);
    const snapshot = await run(() =>
      probeProviderAvailability({
        env: {
          ...process.env,
          ORCAOPS_CLAUDE_PATH: claude,
          ORCAOPS_CODEX_PATH: codex,
        },
        cwd: root,
      })
    );
    expect(snapshot).toEqual({ claude: 'present', codex: 'absent' });
    expect((await readFile(counter, 'utf8')).trim().split('\n').sort()).toEqual([
      'claude-probe',
      'codex-probe',
    ]);
  });

  it('probes providers concurrently and treats timeouts as unverified', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'orcaops-provider-concurrent-'));
    cleanup.push(root);
    const makeHangingBin = async (name: string): Promise<string> => {
      const bin = path.join(root, name);
      await writeFile(bin, "#!/bin/sh\ntrap 'exit 0' TERM\nwhile :; do sleep 1; done\n", {
        mode: 0o755,
      });
      return bin;
    };
    const claude = await makeHangingBin('claude-hang');
    const codex = await makeHangingBin('codex-hang');
    const startedAt = Date.now();
    const snapshot = await run(() =>
      probeProviderAvailability({
        env: {
          PATH: '/usr/bin:/bin',
          ORCAOPS_CLAUDE_PATH: claude,
          ORCAOPS_CODEX_PATH: codex,
        },
        cwd: root,
        timeoutMs: 500,
      })
    );

    expect(snapshot).toEqual({ claude: 'unverified', codex: 'unverified' });
    expect(Date.now() - startedAt).toBeLessThan(950);
  });

  it('prefers confirmed providers, then unverified providers, without overriding explicit choices', () => {
    expect(selectDefaultProvider('auto', { claude: 'unverified', codex: 'present' })).toBe('codex');
    expect(selectDefaultProvider('auto', { claude: 'unverified', codex: 'absent' })).toBe('claude');
    expect(selectDefaultProvider('auto', { claude: 'absent', codex: 'absent' })).toBeNull();
    expect(selectDefaultProvider('claude', { claude: 'absent', codex: 'present' })).toBe('claude');
  });

  it.skipIf(process.platform === 'win32')(
    'halts both the probe leader and its child when the operation is cancelled',
    async () => {
      const root = await mkdtemp(path.join(tmpdir(), 'orcaops-provider-cancel-'));
      cleanup.push(root);
      const leaderPath = path.join(root, 'leader.pid');
      const childPath = path.join(root, 'child.pid');
      const hanging = path.join(root, 'claude-hang');
      await writeFile(
        hanging,
        `#!/bin/sh\nprintf '%s' "$$" > '${leaderPath}'\nsleep 60 &\nprintf '%s' "$!" > '${childPath}'\nwait\n`,
        { mode: 0o755 }
      );

      const task = run(() =>
        probeProviderAvailability({
          env: {
            PATH: '/usr/bin:/bin',
            ORCAOPS_CLAUDE_PATH: hanging,
            ORCAOPS_CODEX_PATH: path.join(root, 'missing-codex'),
          },
          cwd: root,
          timeoutMs: 30_000,
        })
      );
      await waitFor(async () => fileContainsPid(childPath));
      const leaderPid = Number(await readFile(leaderPath, 'utf8'));
      const childPid = Number(await readFile(childPath, 'utf8'));

      await task.halt();
      await waitFor(async () => !processExists(leaderPid) && !processExists(childPid));
    }
  );
});

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function fileContainsPid(file: string): Promise<boolean> {
  try {
    return Number(await readFile(file, 'utf8')) > 0;
  } catch {
    return false;
  }
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('timed out waiting for provider probe process state');
}
