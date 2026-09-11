import { expect, it } from 'vitest';

import { fixture, inventory } from '../helpers/database-history.js';
import { makeAgent } from '../support/test-agent.js';

function agent(f: Awaited<ReturnType<typeof fixture>>, session = 'picker-session') {
  return makeAgent({
    cwd: f.main,
    env: {
      ORCAOPS_ROOT: f.main,
      ORCAOPS_DATA_DIR: f.root,
      ORCAOPS_DISABLE_DRAIN: '1',
      CODEX_SESSION_ID: session,
      CLAUDE_SESSION_ID: '',
      CLAUDE_CODE_SESSION_ID: '',
      TMUX_PANE: '',
      STY: '',
      WINDOW: '',
      TTY: '',
    },
  });
}
it('requires explicit selection among labelled tasks and uses only deliberately published focus', async () => {
  const f = await fixture();
  const first = await f.capture(undefined, { task: 'First original task' });
  const second = await f.capture(undefined, {
    task: 'Second original task',
    ts: '2026-09-06T00:00:00.000Z',
  });
  const a = agent(f);
  const before = await inventory(f.temporary);
  const raw = await a.runRaw(['resume', '--json']);
  const ambiguous = JSON.parse(raw.stdout);
  expect(raw.exitCode).toBe(1);
  expect(ambiguous).toMatchObject({ resolved: false, reason: 'AMBIGUOUS_ARTIFACT' });
  expect(new Set(ambiguous.candidates.map((x: { artifact_id: string }) => x.artifact_id))).toEqual(
    new Set([first, second])
  );
  expect(
    ambiguous.candidates.every(
      (x: { label: string; command: string }) => x.label && x.command.includes('--project')
    )
  ).toBe(true);
  expect(ambiguous).not.toHaveProperty('default_candidate_id');
  expect(await inventory(f.temporary)).toEqual(before);
  const status = JSON.parse((await a.runRaw(['status', '--json'])).stdout);
  expect(status.focus[0].pin).toBeNull();
  expect((await a.runRaw(['checkout', first, '--json'])).exitCode).toBe(0);
  const focused = await inventory(f.temporary);
  const selected = JSON.parse((await a.runRaw(['resume', '--json'])).stdout);
  expect(selected).toMatchObject({ resolved: true, resolution_via: 'pin', artifact_id: first });
  expect(await inventory(f.temporary)).toEqual(focused);
  expect(
    JSON.parse((await agent(f, '').runRaw(['status', '--json'])).stdout).focus[0].pin
  ).toBeNull();
  expect((await a.runRaw(['checkout', '--clear', '--json'])).exitCode).toBe(0);
  expect(JSON.parse((await a.runRaw(['resume', '--json'])).stdout).reason).toBe(
    'AMBIGUOUS_ARTIFACT'
  );
}, 30_000);
it('uses a remaining eligible task when retained completed focus is ineligible, without clearing history', async () => {
  const f = await fixture();
  const completed = await f.capture(undefined, { reason: 'completed' });
  const active = await f.capture();
  const a = agent(f);
  expect((await a.runRaw(['checkout', completed, '--json'])).exitCode).toBe(0);
  const before = await inventory(f.temporary);
  expect(JSON.parse((await a.runRaw(['resume', '--json'])).stdout)).toMatchObject({
    resolved: true,
    resolution_via: 'unique',
    artifact_id: active,
  });
  expect(JSON.parse((await a.runRaw(['status', '--json'])).stdout).focus[0].pin.artifact_id).toBe(
    completed
  );
  expect(await inventory(f.temporary)).toEqual(before);
  for (const flag of ['--accept-default', '--no-pin'])
    expect((await a.runRaw(['resume', flag, '--json'])).exitCode).toBe(1);
  expect(await inventory(f.temporary)).toEqual(before);
}, 20_000);
