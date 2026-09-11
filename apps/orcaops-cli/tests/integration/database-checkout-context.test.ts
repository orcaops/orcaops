import { expect, it } from 'vitest';

import { publishDatabaseCheckout } from '@orcaops/core/history/database-checkout';

import { prepareDatabaseCheckoutCommand } from '../../src/lib/database-checkout.js';
import { runInInvocationContext } from '../../src/lib/invocation-context.js';
import { fixture, inventory } from '../helpers/database-history.js';
import { makeAgent } from '../support/test-agent.js';

function environment(f: Awaited<ReturnType<typeof fixture>>) {
  return {
    ORCAOPS_ROOT: f.main,
    ORCAOPS_DATA_DIR: f.root,
    ORCAOPS_DISABLE_DRAIN: '1',
    CODEX_SESSION_ID: 'original-session',
    CLAUDE_SESSION_ID: '',
    CLAUDE_CODE_SESSION_ID: '',
    TMUX_PANE: '',
    STY: '',
    WINDOW: '',
    TTY: '',
  };
}
it('detaches original selector and invocation context before discovery, with passive preparation', async () => {
  const f = await fixture();
  const first = await f.capture();
  const second = await f.capture(undefined, { cwd: f.linked });
  const frame = { cwd: f.main, env: environment(f) };
  const options = { artifactId: first, project: f.authority.projectId };
  const before = await inventory(f.temporary);
  const request = await runInInvocationContext(frame, async () => {
    const promise = prepareDatabaseCheckoutCommand(options);
    options.artifactId = second;
    frame.cwd = f.linked;
    frame.env.ORCAOPS_ROOT = f.linked;
    frame.env.CODEX_SESSION_ID = 'different-session';
    return promise;
  });
  expect(request.identity.artifactId).toBe(first);
  expect(request.shellKey).toEqual({ kind: 'codex_session', value: 'original-session' });
  expect(await inventory(f.temporary)).toEqual(before);
  const result = await publishDatabaseCheckout(f.writer, request.prepared);
  expect(result).toMatchObject({ artifactId: first, binding: null, focus: { state: 'updated' } });
}, 20_000);
it('honors explicit relative root over the environment checkout without selecting another project', async () => {
  const f = await fixture();
  const id = await f.capture(undefined, { cwd: f.linked });
  const agent = makeAgent({ cwd: f.temporary, env: environment(f) });
  const result = await agent.runRaw([
    '--root',
    'linked',
    'checkout',
    id,
    '--project',
    f.authority.projectId,
    '--json',
  ]);
  expect(result.exitCode, result.stdout + result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({
    artifact_id: id,
    binding: { state: 'unchanged' },
    project_id: f.authority.projectId,
  });
}, 20_000);
