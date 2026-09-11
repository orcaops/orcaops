import { expect, it } from 'vitest';

import { readProjectArtifact } from '@orcaops/storage/history/database';

import { fixture, git, inventory } from '../helpers/database-history.js';
import { makeAgent } from '../support/test-agent.js';

it('preserves original lineage for explicit evidence while refusing reachable-HEAD implicit fallback', async () => {
  const f = await fixture();
  const id = await f.capture(undefined, { task: 'Original main branch task' });
  const original = readProjectArtifact(f.writer, id)!;
  const agent = makeAgent({
    cwd: f.main,
    env: {
      ORCAOPS_ROOT: f.main,
      ORCAOPS_DATA_DIR: f.root,
      ORCAOPS_DISABLE_DRAIN: '1',
      CODEX_SESSION_ID: 'lineage-session',
      CLAUDE_SESSION_ID: '',
      CLAUDE_CODE_SESSION_ID: '',
      TMUX_PANE: '',
      STY: '',
      WINDOW: '',
      TTY: '',
    },
  });
  expect(JSON.parse((await agent.runRaw(['resume', '--json'])).stdout)).toMatchObject({
    resolved: true,
    resolution_via: 'unique',
    artifact_id: id,
  });
  await git(f.main, ['checkout', '-qb', 'sibling']);
  for (const descendant of [false, true]) {
    if (descendant) await git(f.main, ['commit', '--allow-empty', '-qm', 'Descendant']);
    const before = await inventory(f.temporary);
    expect(JSON.parse((await agent.runRaw(['resume', '--json'])).stdout)).toMatchObject({
      resolved: false,
      reason: 'NO_ELIGIBLE_ARTIFACT',
    });
    const exact = JSON.parse((await agent.runRaw(['resume', '--artifact', id, '--json'])).stdout);
    expect(exact).toMatchObject({
      resolved: true,
      artifact_id: id,
      resolution_via: 'explicit',
      eligibility: { state: 'ineligible' },
      plan_event_id: original.thread.plan!.source_event_id,
    });
    expect(exact.artifact.branch_lineage).toEqual(original.thread.artifactJson!.branch_lineage);
    expect(exact.source_versions.artifact).toEqual(original.revision);
    expect(await inventory(f.temporary)).toEqual(before);
  }
  const sibling = await f.capture(undefined, { task: 'Current branch task' });
  const before = await inventory(f.temporary);
  expect(JSON.parse((await agent.runRaw(['resume', '--json'])).stdout).artifact_id).toBe(sibling);
  const human = await agent.runRaw(['resume', '--artifact', id]);
  expect(human.exitCode, human.stderr).toBe(0);
  expect(human.stdout).toContain('Original main branch task');
  expect(human.stdout).not.toContain('SHA reachability');
  expect(await inventory(f.temporary)).toEqual(before);
}, 30_000);
