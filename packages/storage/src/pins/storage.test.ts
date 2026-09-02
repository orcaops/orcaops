import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  clearPin,
  listPinsForRepo,
  type Pin,
  pinFilePath,
  pinIdentity,
  pinRepoDir,
  pinStoreRoot,
  readPin,
  withPinFileLock,
  writePin,
} from './storage.js';

let xdgRoot: string;

beforeEach(async () => {
  xdgRoot = await mkdtemp(path.join(tmpdir(), 'orcaops-pins-'));
});

afterEach(async () => {
  // mkdtemp cleanup not strictly needed; test framework reaps tmpdir.
});

function envWithXdg(): NodeJS.ProcessEnv {
  return { XDG_STATE_HOME: xdgRoot };
}

function samplePin(over: Partial<Pin> = {}): Pin {
  return {
    schema_version: 1,
    artifact_id: '01J9XR000000000000000000AA',
    branch: 'main',
    shell_key: { kind: 'claude_session', value: 'sess_abc' },
    pinned_at: '2026-04-26T18:00:00.000Z',
    pinned_via: 'auto-on-capture-plan',
    ...over,
  };
}

describe('pinStoreRoot / pinRepoDir / pinFilePath', () => {
  it('uses XDG_STATE_HOME when set', () => {
    expect(pinStoreRoot(envWithXdg())).toBe(path.join(xdgRoot, 'orcaops', 'pins'));
  });

  it('falls back to ~/.local/state when XDG_STATE_HOME is unset', () => {
    const root = pinStoreRoot({});
    expect(root.endsWith(path.join('.local', 'state', 'orcaops', 'pins'))).toBe(true);
  });

  it('treats empty XDG_STATE_HOME as unset', () => {
    const empty = pinStoreRoot({ XDG_STATE_HOME: '' });
    const unset = pinStoreRoot({});
    expect(empty).toBe(unset);
  });

  it('repo dir nests repoId under root', () => {
    expect(pinRepoDir('abc123', envWithXdg())).toBe(
      path.join(xdgRoot, 'orcaops', 'pins', 'abc123')
    );
  });

  it('pin file embeds shell-key id under the repo dir', () => {
    const file = pinFilePath('abc123', { kind: 'claude_session', value: 's' }, envWithXdg());
    expect(file.startsWith(path.join(xdgRoot, 'orcaops', 'pins', 'abc123'))).toBe(true);
    expect(file.endsWith('.json')).toBe(true);
    expect(path.basename(file).startsWith('claude_session-')).toBe(true);
  });
});

describe('writePin / readPin / clearPin', () => {
  it('round-trips a freshly-written pin', async () => {
    const pin = samplePin();
    const file = await writePin(pin, { repoId: 'r1', env: envWithXdg() });
    expect(path.basename(file)).toMatch(/^claude_session-[0-9a-f]{16}\.json$/);

    const read = await readPin({ repoId: 'r1', key: pin.shell_key, env: envWithXdg() });
    expect(read).toEqual(pin);
  });

  it('writes canonical JSON (deterministic key order on disk)', async () => {
    const pin = samplePin();
    const file = await writePin(pin, { repoId: 'r1', env: envWithXdg() });
    const raw = await readFile(file, 'utf8');
    // canonicalJson sorts keys; schema_version comes alphabetically after artifact_id, branch.
    expect(raw.indexOf('"artifact_id"')).toBeLessThan(raw.indexOf('"shell_key"'));
    expect(raw.indexOf('"pinned_at"')).toBeLessThan(raw.indexOf('"shell_key"'));
  });

  it('readPin returns null when no pin file exists', async () => {
    const result = await readPin({
      repoId: 'r1',
      key: { kind: 'claude_session', value: 'never-written' },
      env: envWithXdg(),
    });
    expect(result).toBeNull();
  });

  it('readPin returns null for kind=none (no pin possible)', async () => {
    const result = await readPin({ repoId: 'r1', key: { kind: 'none' }, env: envWithXdg() });
    expect(result).toBeNull();
  });

  it('readPin returns null for malformed JSON on disk', async () => {
    const dir = pinRepoDir('r1', envWithXdg());
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'claude_session-deadbeefdeadbeef.json'), 'not json', 'utf8');
    // Use a key that hashes to the same file name we wrote — easier: write
    // via the helper, then corrupt.
    const pin = samplePin();
    const file = await writePin(pin, { repoId: 'r1', env: envWithXdg() });
    await writeFile(file, 'not json', 'utf8');
    const result = await readPin({ repoId: 'r1', key: pin.shell_key, env: envWithXdg() });
    expect(result).toBeNull();
  });

  it('readPin returns null when JSON is valid but schema-invalid', async () => {
    const pin = samplePin();
    const file = await writePin(pin, { repoId: 'r1', env: envWithXdg() });
    await writeFile(file, JSON.stringify({ schema_version: 99, artifact_id: 'x' }), 'utf8');
    const result = await readPin({ repoId: 'r1', key: pin.shell_key, env: envWithXdg() });
    expect(result).toBeNull();
  });

  it('writePin refuses kind=none', async () => {
    await expect(
      writePin({ ...samplePin(), shell_key: { kind: 'none' } }, { repoId: 'r1', env: envWithXdg() })
    ).rejects.toThrow(/kind is "none"/);
  });

  it('writePin rejects schema-invalid input', async () => {
    await expect(
      writePin(
        // @ts-expect-error — bogus schema_version
        { ...samplePin(), schema_version: 2 },
        { repoId: 'r1', env: envWithXdg() }
      )
    ).rejects.toThrow();
  });

  it('clearPin removes the file and returns true', async () => {
    const pin = samplePin();
    await writePin(pin, { repoId: 'r1', env: envWithXdg() });
    const removed = await clearPin({ repoId: 'r1', key: pin.shell_key, env: envWithXdg() });
    expect(removed).toBe(true);
    const after = await readPin({ repoId: 'r1', key: pin.shell_key, env: envWithXdg() });
    expect(after).toBeNull();
  });

  it('clearPin is idempotent (returns false when no file)', async () => {
    const removed = await clearPin({
      repoId: 'r1',
      key: { kind: 'claude_session', value: 'no-such-key' },
      env: envWithXdg(),
    });
    expect(removed).toBe(false);
  });

  it('clearPin returns false for kind=none', async () => {
    expect(await clearPin({ repoId: 'r1', key: { kind: 'none' }, env: envWithXdg() })).toBe(false);
  });

  it('gives content changes distinct compare identities', () => {
    const original = samplePin();
    expect(pinIdentity(original)).toBe(pinIdentity({ ...original }));
    expect(pinIdentity(original)).not.toBe(
      pinIdentity({ ...original, artifact_id: '01J9XR000000000000000000BB' })
    );
  });

  it('serializes a concurrent replacement behind a locked compare-and-clear', async () => {
    const original = samplePin();
    const replacement = samplePin({ artifact_id: '01J9XR000000000000000000BB' });
    await writePin(original, { repoId: 'r1', env: envWithXdg() });

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const inside = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const compareAndClear = withPinFileLock(
      { repoId: 'r1', key: original.shell_key, env: envWithXdg() },
      async (pinFile) => {
        const current = await pinFile.read();
        expect(current === null ? null : pinIdentity(current)).toBe(pinIdentity(original));
        entered();
        await gate;
        await pinFile.clear();
      }
    );
    await inside;

    let replacementFinished = false;
    const replace = writePin(replacement, { repoId: 'r1', env: envWithXdg() }).then(() => {
      replacementFinished = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(replacementFinished).toBe(false);

    release();
    await compareAndClear;
    await replace;
    expect(await readPin({ repoId: 'r1', key: original.shell_key, env: envWithXdg() })).toEqual(
      replacement
    );
  });
});

describe('listPinsForRepo', () => {
  it('returns [] when the repo dir does not exist', async () => {
    const pins = await listPinsForRepo({ repoId: 'never', env: envWithXdg() });
    expect(pins).toEqual([]);
  });

  it('returns every readable pin file', async () => {
    await writePin(samplePin({ artifact_id: 'a1' }), { repoId: 'r1', env: envWithXdg() });
    await writePin(
      samplePin({
        artifact_id: 'a2',
        shell_key: { kind: 'tmux_pane', value: '%9' },
      }),
      { repoId: 'r1', env: envWithXdg() }
    );
    const pins = await listPinsForRepo({ repoId: 'r1', env: envWithXdg() });
    expect(pins.map((p) => p.artifact_id).sort()).toEqual(['a1', 'a2']);
  });

  it('skips malformed files silently', async () => {
    await writePin(samplePin({ artifact_id: 'good' }), { repoId: 'r1', env: envWithXdg() });
    const dir = pinRepoDir('r1', envWithXdg());
    await writeFile(path.join(dir, 'broken.json'), 'not json', 'utf8');
    const pins = await listPinsForRepo({ repoId: 'r1', env: envWithXdg() });
    expect(pins.map((p) => p.artifact_id)).toEqual(['good']);
  });

  it('ignores non-.json entries', async () => {
    await writePin(samplePin({ artifact_id: 'good' }), { repoId: 'r1', env: envWithXdg() });
    const dir = pinRepoDir('r1', envWithXdg());
    await writeFile(path.join(dir, 'README'), 'ignore me', 'utf8');
    const pins = await listPinsForRepo({ repoId: 'r1', env: envWithXdg() });
    expect(pins).toHaveLength(1);
  });
});
