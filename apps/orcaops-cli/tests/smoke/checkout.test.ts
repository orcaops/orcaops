import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

import { fixture, inventory } from '../helpers/database-history.js';

const execute = promisify(execFile);
it('uses executable session precedence and original operation replay without automatic focus', async () => {
  const f = await fixture();
  const id = await f.capture();
  const base = {
    ...process.env,
    ORCAOPS_ROOT: f.main,
    ORCAOPS_DATA_DIR: f.root,
    ORCAOPS_DISABLE_DRAIN: '1',
    NODE_DISABLE_COMPILE_CACHE: '1',
    CLAUDE_SESSION_ID: '',
    CLAUDE_CODE_SESSION_ID: '',
    CODEX_SESSION_ID: '',
    TMUX_PANE: '',
    STY: '',
    WINDOW: '',
    TTY: '',
    XDG_STATE_HOME: f.temporary + '/unused-state',
  };
  async function run(args: string[], extras: NodeJS.ProcessEnv) {
    return execute(
      process.execPath,
      [fileURLToPath(new URL('../../bin/orcaops.js', import.meta.url)), ...args, '--json'],
      { cwd: f.main, env: { ...base, ...extras }, timeout: 20_000 }
    );
  }
  for (const [extras, kind] of [
    [
      { CLAUDE_SESSION_ID: 'claude', CODEX_SESSION_ID: 'codex', TMUX_PANE: 'pane' },
      'claude_session',
    ],
    [{ CODEX_SESSION_ID: 'codex', TMUX_PANE: 'pane' }, 'codex_session'],
    [{ TMUX_PANE: 'pane' }, 'tmux_pane'],
  ] as const) {
    const value = JSON.parse((await run(['checkout', id], extras)).stdout);
    expect(value).toMatchObject({
      ok: true,
      schema_version: 3,
      action: 'focused',
      artifact_id: id,
      shell_key: { kind },
    });
    const before = await inventory(f.temporary);
    const replay = JSON.parse(
      (await run(['checkout', '--operation-id', value.operation_id], extras)).stdout
    );
    expect(replay.focus.publication.replayed).toBe(true);
    expect(await inventory(f.temporary)).toEqual(before);
  }
  const before = await inventory(f.temporary);
  await expect(run(['checkout', id], {})).rejects.toMatchObject({
    code: 1,
    stdout: expect.stringContaining('NO_SHELL_KEY'),
  });
  expect(await inventory(f.temporary)).toEqual(before);
}, 30_000);
