import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { queryProjectArtifacts, readProjectArtifact } from '@orcaops/storage/history/database';
import { inputFile } from '@orcaops/test-harness';

import { fixture } from '../helpers/database-history.js';
import { makeAgent } from '../support/test-agent.js';

/**
 * Ported by meaning from tests/integration/capture-plan-routing.test.ts and the
 * option half of tests/integration/source-plan.test.ts, which proved that the bare
 * `capture plan` parent runs the initial capture, that `plan revise` routes its own
 * payload, that `--source-plan` belongs to the parent and never to revise, that a
 * payload option placed before the subverb is refused rather than silently dropped,
 * and that an unresolvable source plan fails loud before any artifact state exists.
 */
type Fixture = Awaited<ReturnType<typeof fixture>>;
function agent(f: Fixture) {
  return makeAgent({
    cwd: f.main,
    env: {
      ORCAOPS_ROOT: f.main,
      ORCAOPS_DATA_DIR: f.root,
      ORCAOPS_DISABLE_DRAIN: '1',
      CODEX_SESSION_ID: 'routing-session',
      CLAUDE_SESSION_ID: '',
      CLAUDE_CODE_SESSION_ID: '',
      TMUX_PANE: '',
      STY: '',
      WINDOW: '',
      TTY: '',
      XDG_STATE_HOME: f.temporary + '/unused-state',
    },
  });
}
function planPayload(key: string) {
  return JSON.stringify({
    idempotency_key: key,
    task: 'Route the capture payload',
    label: 'Routing subject',
    plan_steps: [{ text: 'do the thing', label: 'Do it' }],
    touched_scope: [],
    non_goals: [],
  });
}
function activeCount(f: Fixture) {
  return queryProjectArtifacts(f.writer, { profile: 'versions' }).rows.length;
}

describe('registered database capture plan routing', { timeout: 120_000 }, () => {
  it('captures through the bare parent, routes revise separately and refuses misplaced options', async () => {
    const f = await fixture();
    const captured = await agent(f).runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--input',
      inputFile(planPayload(`plan-${randomUUID()}`)),
    ]);
    expect(captured.exitCode, captured.stdout + captured.stderr).toBe(0);
    const plan = JSON.parse(captured.stdout);
    expect(plan.ok).toBe(true);
    expect(readProjectArtifact(f.writer, plan.artifact_id)!.thread.plan!.revision_n).toBe(0);

    const revised = await agent(f).runRaw([
      'capture',
      'plan',
      'revise',
      '--no-llm',
      '--input',
      inputFile(
        JSON.stringify({
          idempotency_key: `revise-${randomUUID()}`,
          artifact_id: plan.artifact_id,
          label: 'Routed revision',
          rationale: 'The subverb reads its own payload',
          prior_plan_event_id: null,
          plan_steps: [{ text: 'do the other thing', label: 'Do the other' }],
          touched_scope: [],
          non_goals: [],
        })
      ),
    ]);
    expect(revised.exitCode, revised.stdout + revised.stderr).toBe(0);
    expect(JSON.parse(revised.stdout).revision_n).toBe(1);

    const misplaced = await agent(f).runRaw([
      'capture',
      'plan',
      '--no-llm',
      'revise',
      '--input',
      inputFile(planPayload(`plan-${randomUUID()}`)),
    ]);
    expect(misplaced.exitCode).toBe(1);
    expect(misplaced.stdout + misplaced.stderr).toMatch(/after 'revise'/);

    const onRevise = await agent(f).runRaw([
      'capture',
      'plan',
      'revise',
      '--source-plan',
      'does-not-matter.md',
      '--input',
      inputFile(planPayload(`plan-${randomUUID()}`)),
    ]);
    expect(onRevise.exitCode).toBe(1);
    expect(onRevise.stderr).toMatch(/unknown option/);

    const malformed = await agent(f).runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--input',
      inputFile('{definitely not yaml: ['),
    ]);
    expect(malformed.exitCode).toBe(1);
    expect(JSON.parse(malformed.stdout).error.code).toBe('INVALID_INPUT');
  });

  it('pins a source plan on the parent and refuses one it cannot resolve without leaving state', async () => {
    const f = await fixture();
    const sourcePlan = path.join(f.temporary, 'slice-plan.md');
    await writeFile(sourcePlan, '# the plan\n\ndo the thing\n', 'utf8');
    const pinned = await agent(f).runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--source-plan',
      sourcePlan,
      '--input',
      inputFile(planPayload(`plan-${randomUUID()}`)),
    ]);
    expect(pinned.exitCode, pinned.stdout + pinned.stderr).toBe(0);
    expect(JSON.parse(pinned.stdout).source_plan).toMatchObject({
      pinned: true,
      source_ref: { kind: 'local', locator: sourcePlan },
    });

    const before = activeCount(f);
    const key = `plan-${randomUUID()}`;
    const missing = await agent(f).runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--source-plan',
      path.join(f.temporary, 'never-existed.md'),
      '--input',
      inputFile(planPayload(key)),
    ]);
    expect(missing.exitCode).toBe(1);
    expect(JSON.parse(missing.stdout).error).toMatchObject({
      code: 'NO_INPUT',
      path: 'source-plan',
    });
    expect(activeCount(f)).toBe(before);
    // The refusal precedes every idempotency record, so the same key still creates.
    const retry = await agent(f).runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--input',
      inputFile(planPayload(key)),
    ]);
    expect(retry.exitCode, retry.stdout + retry.stderr).toBe(0);
    expect(JSON.parse(retry.stdout).idempotency_status).toBe('created');

    const cloud = await agent(f).runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--source-plan',
      'cloud:01HX0K8N6ZQF8M5R2V8DZ7T3KX@2',
      '--input',
      inputFile(planPayload(`plan-${randomUUID()}`)),
    ]);
    expect(cloud.exitCode).toBe(1);
    expect(JSON.parse(cloud.stdout).error.code).toBe('NO_INPUT');
  });
});
