import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { uuidv7 } from '@orcaops/storage';
import { listProjectTaskUses } from '@orcaops/storage/history/database';
import { inputFile } from '@orcaops/test-harness';

import { fixture, git, inventory } from '../helpers/database-history.js';
import { adoptedRequirement, type AdoptedRequirement } from '../helpers/knowledge-records.js';
import { readArtifactExport } from '../support/artifact-export.js';
import { makeAgent } from '../support/test-agent.js';

type Fixture = Awaited<ReturnType<typeof fixture>>;

const OFFLINE = 'Local capture works with no Cloud connection.';
const SECRETS = 'Refused content never reaches a retained payload.';
const LATER = 'An upgrade preserves every retained record.';

function agent(f: Fixture) {
  return makeAgent({
    cwd: f.main,
    timeoutMs: 90_000,
    env: {
      ORCAOPS_ROOT: f.main,
      ORCAOPS_DATA_DIR: f.root,
      ORCAOPS_DISABLE_DRAIN: '1',
      CODEX_SESSION_ID: 'uses-session',
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

async function run(f: Fixture, args: string[]) {
  const raw = await agent(f).runRaw(args);
  return { raw, result: JSON.parse(raw.stdout) as Record<string, never> };
}

const withInput = (verb: string[], body: unknown, flags: string[] = ['--no-llm']) => [
  ...verb,
  ...flags,
  '--input',
  inputFile(JSON.stringify(body)),
];

const use = (adopted: AdoptedRequirement, role: string) => ({
  kind: 'requirement',
  entity_id: adopted.requirementId,
  revision_id: adopted.revisionId,
  role,
});

function planPayload(uses: unknown[], extra: Record<string, unknown> = {}) {
  return {
    idempotency_key: `plan-${randomUUID()}`,
    task: 'Keep the recorded rules in view while the work runs',
    label: 'Rules in view',
    plan_steps: [
      {
        text: 'do the work',
        label: 'Do it',
        acceptance_criteria: [{ text: 'the step is delivered' }],
      },
    ],
    touched_scope: [],
    non_goals: [],
    knowledge_uses: uses,
    ...extra,
  };
}

const retainedUses = (f: Fixture, planEventId: string) =>
  f.writer.read((view) => listProjectTaskUses(view, planEventId)).value;

/** `knowledge lookup` resolves its project through the repository install, so it needs one. */
async function installed(): Promise<Fixture> {
  const f = await fixture();
  await mkdir(path.join(f.main, '.orcaops'), { recursive: true });
  await writeFile(
    path.join(f.main, '.orcaops', 'config.json'),
    JSON.stringify({ schema_version: 6, install: { scope: 'project' }, llm: { tool: 'none' } }),
    'utf8'
  );
  return f;
}

async function twoRules(f: Fixture) {
  const projectId = f.authority.projectId;
  const offline = await adoptedRequirement(f.writer, { projectId, statement: OFFLINE });
  const secrets = await adoptedRequirement(f.writer, { projectId, statement: SECRETS });
  return { offline, secrets };
}

describe('a plan records what it uses', { timeout: 120_000 }, () => {
  it('settles the revisions a plan capture names as selected with the plan, and a checkpoint opened against that revision reports the same ones', async () => {
    const f = await fixture();
    const { offline, secrets } = await twoRules(f);

    const captured = await run(
      f,
      withInput(
        ['capture', 'plan'],
        planPayload([use(offline, 'implement'), use(secrets, 'preserve')])
      )
    );
    expect(captured.raw.exitCode, captured.raw.stdout + captured.raw.stderr).toBe(0);
    const planEventId = captured.result.plan_event_id as unknown as string;
    const artifactId = captured.result.artifact_id as unknown as string;

    const rows = retainedUses(f, planEventId);
    expect(rows.map((row) => [row.target.revisionId, row.role, row.selectionKind]).sort()).toEqual(
      [
        [offline.revisionId, 'implement', 'selected_with_plan'],
        [secrets.revisionId, 'preserve', 'selected_with_plan'],
      ].sort()
    );
    expect(rows.every((row) => row.discoveredAt === null && row.discoveredBy === null)).toBe(true);
    expect(
      (captured.result.knowledge_uses as unknown as { selected_with_plan: unknown[] })
        .selected_with_plan
    ).toHaveLength(2);

    const stepIds = (captured.result.plan_steps as unknown as { step_id: string }[]).map(
      (step) => step.step_id
    );
    const opened = await run(
      f,
      withInput(['capture', 'checkpoint', 'open'], {
        idempotency_key: `open-${randomUUID()}`,
        artifact_id: artifactId,
        declared_step_ids: stepIds,
      })
    );
    expect(opened.raw.exitCode, opened.raw.stdout + opened.raw.stderr).toBe(0);
    // Opening writes no use of its own: it pins a plan revision, and the uses of that revision
    // are what it opened against.
    expect(retainedUses(f, planEventId)).toHaveLength(2);

    // A connection found after the plan is keyed to the same plan event and must never join the
    // list of what the plan itself selected.
    const later = await adoptedRequirement(f.writer, {
      projectId: f.authority.projectId,
      statement: LATER,
    });
    const connected = await run(f, [
      'task',
      'uses',
      'record',
      '--artifact',
      artifactId,
      '--plan-event',
      planEventId,
      '--identity',
      `requirement:${later.requirementId}`,
      '--revision',
      later.revisionId,
      '--role',
      'background',
      '--discovered-at',
      '2026-09-18T00:00:00.000Z',
      '--discovered-by',
      'owner',
      '--json',
    ]);
    expect(connected.raw.exitCode, connected.raw.stdout + connected.raw.stderr).toBe(0);

    const shown = { result: JSON.parse((await readArtifactExport(agent(f), artifactId)).stdout) };
    const checkpoint = (
      shown.result.artifact as unknown as {
        checkpoints: {
          knowledge_uses: {
            selected_with_plan: { target: { revision_id: string } }[];
            connected_later: { target: { revision_id: string } }[];
          };
        }[];
      }
    ).checkpoints[0]!;
    expect(
      checkpoint.knowledge_uses.selected_with_plan.map((entry) => entry.target.revision_id).sort()
    ).toEqual([offline.revisionId, secrets.revisionId].sort());
    expect(
      checkpoint.knowledge_uses.connected_later.map((entry) => entry.target.revision_id)
    ).toEqual([later.revisionId]);

    const resumed = await run(f, ['resume', '--artifact', artifactId, '--format', 'json']);
    const open = (
      resumed.result.artifact as unknown as {
        open_checkpoints: {
          knowledge_uses: {
            selected_with_plan: { target: { revision_id: string } }[];
            connected_later: { target: { revision_id: string } }[];
          };
        }[];
      }
    ).open_checkpoints[0]!;
    expect(
      open.knowledge_uses.selected_with_plan.map((entry) => entry.target.revision_id).sort()
    ).toEqual([offline.revisionId, secrets.revisionId].sort());
    expect(open.knowledge_uses.connected_later.map((entry) => entry.target.revision_id)).toEqual([
      later.revisionId,
    ]);
  });

  it('records the uses of the new plan event when a revision carries one and drops the other', async () => {
    const f = await fixture();
    const { offline, secrets } = await twoRules(f);
    const captured = await run(
      f,
      withInput(
        ['capture', 'plan'],
        planPayload([use(offline, 'implement'), use(secrets, 'preserve')])
      )
    );
    const artifactId = captured.result.artifact_id as unknown as string;
    const originalEventId = captured.result.plan_event_id as unknown as string;
    const stepIds = (captured.result.plan_steps as unknown as { step_id: string }[]).map(
      (step) => step.step_id
    );

    const revised = await run(
      f,
      withInput(['capture', 'plan', 'revise'], {
        idempotency_key: `revise-${randomUUID()}`,
        artifact_id: artifactId,
        label: 'Rules in view, narrowed',
        rationale: 'The second rule turned out not to bear on this work.',
        prior_plan_event_id: originalEventId,
        plan_steps: [
          {
            step_id: stepIds[0],
            text: 'do the work',
            label: 'Do it',
            acceptance_criteria: [{ text: 'the step is delivered' }],
          },
          { text: 'prove it', label: 'Prove it', acceptance_criteria: [{ text: 'tests pass' }] },
        ],
        touched_scope: [],
        non_goals: [],
        knowledge_uses: [use(offline, 'implement')],
      })
    );
    expect(revised.raw.exitCode, revised.raw.stdout + revised.raw.stderr).toBe(0);
    const revisedUses = revised.result.knowledge_uses as unknown as {
      plan_event_id: string;
      selected_with_plan: { target: { revision_id: string } }[];
    };
    expect(revisedUses.selected_with_plan.map((entry) => entry.target.revision_id)).toEqual([
      offline.revisionId,
    ]);
    expect(revisedUses.plan_event_id).not.toBe(originalEventId);

    // The dropped use is not a use of the new revision, and it is still a use of the revision
    // that did select it: the earlier plan event's record does not move.
    expect(retainedUses(f, revisedUses.plan_event_id).map((row) => row.target.revisionId)).toEqual([
      offline.revisionId,
    ]);
    expect(
      retainedUses(f, originalEventId)
        .map((row) => row.target.revisionId)
        .sort()
    ).toEqual([offline.revisionId, secrets.revisionId].sort());
  });

  it('compares a historical lookup with the plan visible at that boundary', async () => {
    const f = await installed();
    const adopted = await adoptedRequirement(f.writer, {
      projectId: f.authority.projectId,
      statement: OFFLINE,
    });
    const captured = await run(
      f,
      withInput(['capture', 'plan'], planPayload([use(adopted, 'implement')]))
    );
    expect(captured.raw.exitCode, captured.raw.stdout + captured.raw.stderr).toBe(0);
    const boundary = f.writer.read(() => null).counters.writeSequence;
    const artifactId = captured.result.artifact_id as unknown as string;
    const originalEventId = captured.result.plan_event_id as unknown as string;
    const stepId = (captured.result.plan_steps as unknown as { step_id: string }[])[0]!.step_id;
    const revised = await run(
      f,
      withInput(['capture', 'plan', 'revise'], {
        idempotency_key: `revise-${randomUUID()}`,
        artifact_id: artifactId,
        label: 'No retained use',
        rationale: 'Exercise historical plan selection.',
        prior_plan_event_id: originalEventId,
        plan_steps: [
          {
            step_id: stepId,
            text: 'do the work differently',
            label: 'Do it',
            acceptance_criteria: [{ text: 'the step is delivered' }],
          },
        ],
        touched_scope: [],
        non_goals: [],
        knowledge_uses: [],
      })
    );
    expect(revised.raw.exitCode, revised.raw.stdout + revised.raw.stderr).toBe(0);

    const lookup = await run(f, [
      'knowledge',
      'lookup',
      '--adopted',
      '--at-boundary',
      String(boundary),
      '--json',
    ]);
    expect(lookup.raw.exitCode, lookup.raw.stdout + lookup.raw.stderr).toBe(0);
    expect(lookup.result.task_selection).toEqual({
      kind: 'selected',
      artifact_id: artifactId,
      plan_event_id: originalEventId,
    });
    const notSelected = lookup.result.applicable_not_selected as unknown as {
      plan_event_id: string;
      entries: unknown[];
    };
    expect(notSelected.plan_event_id).toBe(originalEventId);
    expect(notSelected.entries).toEqual([]);
  });

  it('reports ambiguous active tasks without choosing either plan', async () => {
    const f = await installed();
    await adoptedRequirement(f.writer, {
      projectId: f.authority.projectId,
      statement: OFFLINE,
    });
    const first = await run(f, withInput(['capture', 'plan'], planPayload([])));
    const second = await run(f, withInput(['capture', 'plan'], planPayload([])));
    expect(first.raw.exitCode, first.raw.stdout + first.raw.stderr).toBe(0);
    expect(second.raw.exitCode, second.raw.stdout + second.raw.stderr).toBe(0);

    const lookup = await run(f, ['knowledge', 'lookup', '--adopted', '--json']);
    expect(lookup.raw.exitCode, lookup.raw.stdout + lookup.raw.stderr).toBe(0);
    expect(lookup.result.task_selection).toEqual({
      kind: 'ambiguous',
      artifact_ids: [first.result.artifact_id, second.result.artifact_id].sort(),
    });
    expect(
      (lookup.result.applicable_not_selected as unknown as { statement: string }).statement
    ).toContain('no task or plan was guessed');
  });

  it('refuses the whole capture when a use names a revision this history does not hold', async () => {
    const f = await fixture();
    const { offline } = await twoRules(f);
    // A first capture registers the worktree and settles the project, so what the refusal below
    // must leave unchanged is the store as it stands after ordinary use.
    await run(f, withInput(['capture', 'plan'], planPayload([use(offline, 'implement')])));
    const before = await inventory(f.root);

    const refused = await agent(f).runRaw(
      withInput(
        ['capture', 'plan'],
        planPayload([
          use(offline, 'implement'),
          { kind: 'requirement', entity_id: uuidv7(), revision_id: uuidv7(), role: 'preserve' },
        ])
      )
    );

    expect(refused.exitCode).not.toBe(0);
    expect(JSON.parse(refused.stdout)).toMatchObject({
      ok: false,
      error: { code: 'HISTORY_MISSING' },
    });
    expect(await inventory(f.root)).toEqual(before);
  });

  it.each(['enabled', 'disabled', 'unavailable'] as const)(
    'writes no second use when the same plan capture key is replayed with snapshots %s',
    async (snapshots) => {
      const f = await installed();
      if (snapshots === 'disabled') {
        await writeFile(
          path.join(f.main, '.orcaops', 'config.json'),
          JSON.stringify({
            schema_version: 6,
            install: { scope: 'project' },
            llm: { tool: 'none' },
            diff_fingerprint: { enabled: false },
          })
        );
      } else if (snapshots === 'unavailable') {
        await writeFile(
          path.join(f.main, '.gitattributes'),
          'snapshot-input.txt filter=reject-snapshot\n'
        );
        await writeFile(
          path.join(f.main, 'snapshot-input.txt'),
          'The snapshot filter refuses these bytes.\n'
        );
        await git(f.main, ['config', '--local', 'filter.reject-snapshot.clean', 'false']);
        await git(f.main, ['config', '--local', 'filter.reject-snapshot.required', 'true']);
      }
      const { offline, secrets } = await twoRules(f);
      const body = planPayload([use(offline, 'implement'), use(secrets, 'preserve')]);
      const captured = await run(f, withInput(['capture', 'plan'], body));
      expect(captured.raw.exitCode, captured.raw.stdout + captured.raw.stderr).toBe(0);
      if (snapshots === 'unavailable')
        expect(captured.raw.stdout + captured.raw.stderr).toContain(
          'Plan baseline snapshot is unavailable'
        );
      const planEventId = captured.result.plan_event_id as unknown as string;
      const before = await inventory(f.root);

      const replayed = await run(f, withInput(['capture', 'plan'], body));

      expect(replayed.raw.exitCode, replayed.raw.stdout + replayed.raw.stderr).toBe(0);
      expect(replayed.result.idempotency_status).toBe('replay');
      expect(replayed.result.plan_event_id).toBe(planEventId);
      expect(retainedUses(f, planEventId)).toHaveLength(2);
      expect(await inventory(f.root)).toEqual(before);
      const conflict = await agent(f).runRaw(
        withInput(['capture', 'plan'], {
          ...body,
          knowledge_uses: [use(offline, 'preserve'), use(secrets, 'preserve')],
        })
      );
      expect(conflict.exitCode).not.toBe(0);
      expect(JSON.parse(conflict.stdout)).toMatchObject({
        ok: false,
        error: { code: 'IDEMPOTENCY_CONFLICT' },
      });
      expect(await inventory(f.root)).toEqual(before);
    }
  );

  it('refuses a plan capture key reused with a different selection', async () => {
    const f = await fixture();
    const { offline, secrets } = await twoRules(f);
    const body = planPayload([use(offline, 'implement')]);
    await run(f, withInput(['capture', 'plan'], body));

    const conflict = await agent(f).runRaw(
      withInput(['capture', 'plan'], { ...body, knowledge_uses: [use(secrets, 'implement')] })
    );

    expect(conflict.exitCode).not.toBe(0);
    expect(JSON.parse(conflict.stdout)).toMatchObject({
      ok: false,
      error: { code: 'IDEMPOTENCY_CONFLICT' },
    });
  });

  it('lists an adopted requirement the plan left out under applicable and not selected', async () => {
    const f = await installed();
    const { offline, secrets } = await twoRules(f);
    const captured = await run(
      f,
      withInput(['capture', 'plan'], planPayload([use(offline, 'implement')]))
    );
    const planEventId = captured.result.plan_event_id as unknown as string;

    const looked = await run(f, [
      'knowledge',
      'lookup',
      '--identity',
      `requirement:${secrets.requirementId}`,
      '--json',
    ]);
    const missed = looked.result.applicable_not_selected as unknown as {
      plan_event_id: string;
      entries: { key: string; revision_ids: string[] }[];
    };
    expect(missed.plan_event_id).toBe(planEventId);
    expect(missed.entries).toEqual([
      expect.objectContaining({
        key: `requirement:${secrets.requirementId}`,
        revision_ids: [secrets.revisionId],
      }),
    ]);

    const selected = await run(f, [
      'knowledge',
      'lookup',
      '--identity',
      `requirement:${offline.requirementId}`,
      '--json',
    ]);
    expect(
      (selected.result.applicable_not_selected as unknown as { entries: unknown[] }).entries
    ).toEqual([]);

    const status = await run(f, ['status', '--json']);
    const reported = status.result.applicable_not_selected as unknown as {
      plan_event_id: string;
      entries: { key: string }[];
    };
    expect(reported.plan_event_id).toBe(planEventId);
    expect(reported.entries.map((entry) => entry.key)).toEqual([
      `requirement:${secrets.requirementId}`,
    ]);
  });
});
