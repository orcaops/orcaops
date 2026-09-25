// The workflow the shipped skills describe, driven end to end: look the record up before
// planning, carry the exact revisions into the plan, and open a checkpoint against that plan.
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { SKILL_TEMPLATES, TOOL_ADAPTERS } from '@orcaops/adapters';
import { inputFile } from '@orcaops/test-harness';

import { fixture } from '../helpers/database-history.js';
import { adoptedRequirement, type AdoptedRequirement } from '../helpers/knowledge-records.js';
import { readArtifactExport } from '../support/artifact-export.js';
import { makeAgent } from '../support/test-agent.js';

type Fixture = Awaited<ReturnType<typeof fixture>>;

const OFFLINE = 'Local capture works with no Cloud connection.';
const SECRETS = 'Refused content never reaches a retained payload.';

function agent(f: Fixture) {
  return makeAgent({
    cwd: f.main,
    timeoutMs: 90_000,
    env: {
      ORCAOPS_ROOT: f.main,
      ORCAOPS_DATA_DIR: f.root,
      ORCAOPS_DISABLE_DRAIN: '1',
      CODEX_SESSION_ID: 'planning-session',
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
  expect(raw.exitCode, raw.stdout + raw.stderr).toBe(0);
  return JSON.parse(raw.stdout) as Record<string, never>;
}

/** The same read as a person sees it, which is what the skills tell an agent to reason from. */
async function runText(f: Fixture, args: string[]) {
  const raw = await agent(f).runRaw(args);
  expect(raw.exitCode, raw.stdout + raw.stderr).toBe(0);
  return raw.stdout;
}

const withInput = (verb: string[], body: unknown) => [
  ...verb,
  '--no-llm',
  '--input',
  inputFile(JSON.stringify(body)),
];

const use = (adopted: AdoptedRequirement, role: string) => ({
  kind: 'requirement',
  entity_id: adopted.requirementId,
  revision_id: adopted.revisionId,
  role,
});

function planPayload(uses: unknown[]) {
  return {
    idempotency_key: `plan-${randomUUID()}`,
    task: 'Queue an upload the inspector made while the device was offline',
    label: 'Queue offline uploads',
    plan_steps: [
      {
        text: 'queue the upload and retry it when the device reconnects',
        label: 'Queue and retry',
        acceptance_criteria: [{ text: 'an upload made offline is retried after reconnection' }],
      },
    ],
    touched_scope: ['sync'],
    non_goals: [],
    knowledge_uses: uses,
  };
}

/** `knowledge lookup` and `status` resolve their project through the repository install. */
async function installed(): Promise<Fixture> {
  const f = await fixture();
  await mkdir(path.join(f.main, '.orcaops'), { recursive: true });
  await writeFile(
    path.join(f.main, '.orcaops', 'config.json'),
    JSON.stringify({
      schema_version: 6,
      install: { scope: 'project', agents: ['claude-code', 'codex'] },
      llm: { tool: 'none' },
    }),
    'utf8'
  );
  await run(f, ['update', '--json']);
  for (const id of ['claude-code', 'codex']) {
    const adapter = TOOL_ADAPTERS.find((candidate) => candidate.id === id)!;
    for (const skillId of ['plan-critique', 'capture']) {
      const template = SKILL_TEMPLATES.find((candidate) => candidate.id === skillId)!;
      const installedSkill = await readFile(
        path.join(f.main, adapter.skills!.filePath(skillId, 'orcaops')),
        'utf8'
      );
      const version = /generatedBy: "orcaops@([^"]+)"/.exec(installedSkill)![1]!;
      expect(installedSkill).toBe(adapter.skills!.format(template, { generatedBy: version }));
    }
  }
  return f;
}

const lookupJson = (f: Fixture, adopted: AdoptedRequirement) =>
  run(f, ['knowledge', 'lookup', '--identity', `requirement:${adopted.requirementId}`, '--json']);

interface LookupAnswer {
  applicable: string[];
  background: string[];
  entries: {
    key: string;
    target: { kind: string; entity_id: string };
    revisions: { revision: { revision_id: string }; statement: string | null }[];
  }[];
  coverage: { processing: { claim: string; statement: string } | null };
  applicable_not_selected: { plan_event_id: string | null; entries: { key: string }[] };
}

describe('preparing a task against the rules already recorded', { timeout: 120_000 }, () => {
  it('answers the lookup with the adopted revision, which the plan then selects and the checkpoint opens against', async () => {
    const f = await installed();
    const adopted = await adoptedRequirement(f.writer, {
      projectId: f.authority.projectId,
      statement: OFFLINE,
    });

    const answer = (await lookupJson(f, adopted)) as unknown as LookupAnswer;
    expect(answer.applicable).toEqual([`requirement:${adopted.requirementId}`]);
    expect(answer.background).toEqual([]);
    const entry = answer.entries.find((candidate) => candidate.key === answer.applicable[0])!;
    expect(entry.target).toEqual({ kind: 'requirement', entity_id: adopted.requirementId });
    expect(entry.revisions.map((revision) => revision.revision.revision_id)).toEqual([
      adopted.revisionId,
    ]);
    expect(entry.revisions[0]!.statement).toBe(OFFLINE);

    const captured = await run(
      f,
      withInput(['capture', 'plan'], planPayload([use(adopted, 'implement')]))
    );
    const artifactId = captured.artifact_id as unknown as string;
    const planEventId = captured.plan_event_id as unknown as string;
    const selected = captured.knowledge_uses as unknown as {
      plan_event_id: string;
      selected_with_plan: { target: { revision_id: string }; role: string }[];
      connected_later: unknown[];
    };
    expect(selected.plan_event_id).toBe(planEventId);
    expect(
      selected.selected_with_plan.map((entry) => [entry.target.revision_id, entry.role])
    ).toEqual([[adopted.revisionId, 'implement']]);
    expect(selected.connected_later).toEqual([]);

    const stepIds = (captured.plan_steps as unknown as { step_id: string }[]).map(
      (step) => step.step_id
    );
    await run(
      f,
      withInput(['capture', 'checkpoint', 'open'], {
        idempotency_key: `open-${randomUUID()}`,
        artifact_id: artifactId,
        declared_step_ids: stepIds,
        plan_revision_id: planEventId,
      })
    );

    const shown = JSON.parse((await readArtifactExport(agent(f), artifactId)).stdout);
    const checkpoint = (
      shown.artifact as unknown as {
        checkpoints: {
          knowledge_uses: {
            plan_event_id: string;
            selected_with_plan: { target: { revision_id: string }; role: string }[];
            connected_later: unknown[];
          } | null;
        }[];
      }
    ).checkpoints[0]!;
    // Opening writes no use of its own: the checkpoint reports the uses of the plan revision it
    // pinned, which is what it actually worked from.
    expect(checkpoint.knowledge_uses!.plan_event_id).toBe(planEventId);
    expect(
      checkpoint.knowledge_uses!.selected_with_plan.map((entry) => [
        entry.target.revision_id,
        entry.role,
      ])
    ).toEqual([[adopted.revisionId, 'implement']]);
    expect(checkpoint.knowledge_uses!.connected_later).toEqual([]);

    // And the rule the plan did select is not reported back as one it missed.
    const after = (await lookupJson(f, adopted)) as unknown as LookupAnswer;
    expect(after.applicable_not_selected.plan_event_id).toBe(planEventId);
    expect(after.applicable_not_selected.entries).toEqual([]);
  });

  it('keeps a rule the plan left out visible under applicable and not selected', async () => {
    const f = await installed();
    const projectId = f.authority.projectId;
    const offline = await adoptedRequirement(f.writer, { projectId, statement: OFFLINE });
    const secrets = await adoptedRequirement(f.writer, { projectId, statement: SECRETS });

    // Both are applicable before the plan exists, so leaving one out is a choice, not an absence.
    const before = (await lookupJson(f, secrets)) as unknown as LookupAnswer;
    expect(before.applicable).toEqual([`requirement:${secrets.requirementId}`]);

    const captured = await run(
      f,
      withInput(['capture', 'plan'], planPayload([use(offline, 'implement')]))
    );
    const planEventId = captured.plan_event_id as unknown as string;

    const status = await run(f, ['status', '--json']);
    const missed = status.applicable_not_selected as unknown as {
      plan_event_id: string;
      entries: { key: string; revision_ids: string[]; reason: string }[];
      statement: string;
    };
    expect(missed.plan_event_id).toBe(planEventId);
    expect(missed.entries.map((entry) => entry.key)).toEqual([
      `requirement:${secrets.requirementId}`,
    ]);
    expect(missed.entries[0]!.revision_ids).toEqual([secrets.revisionId]);
    expect(missed.statement).toContain(planEventId);

    const answer = (await lookupJson(f, secrets)) as unknown as LookupAnswer;
    expect(answer.applicable_not_selected.entries.map((entry) => entry.key)).toEqual([
      `requirement:${secrets.requirementId}`,
    ]);
  });

  it('finds an adopted rule whose wording the task never uses, with no identity handed to it', async () => {
    const f = await installed();
    const adopted = await adoptedRequirement(f.writer, {
      projectId: f.authority.projectId,
      statement: SECRETS,
    });

    // The task is about queueing offline uploads and shares no word with the rule, and nothing
    // handed the agent an id: the text and identity routes reach it through neither.
    const byText = (await run(f, [
      'knowledge',
      'lookup',
      'queue an upload the inspector made while the device was offline',
      '--json',
    ])) as unknown as LookupAnswer;
    expect(byText.applicable).toEqual([]);

    const byAdoption = (await run(f, [
      'knowledge',
      'lookup',
      '--adopted',
      '--json',
    ])) as unknown as LookupAnswer;

    expect(byAdoption.applicable).toEqual([`requirement:${adopted.requirementId}`]);
    const entry = byAdoption.entries.find(
      (candidate) => candidate.key === byAdoption.applicable[0]
    );
    expect(entry!.revisions.map((revision) => revision.statement)).toEqual([SECRETS]);
  });

  it('says its identity cap was reached rather than counting the cap as the whole of what applies', async () => {
    const f = await installed();
    const projectId = f.authority.projectId;
    const adopted: AdoptedRequirement[] = [];
    for (let index = 0; index < 51; index += 1)
      adopted.push(
        await adoptedRequirement(f.writer, {
          projectId,
          statement: `Rule number ${index}: uploads keep their origin.`,
        })
      );

    await run(f, withInput(['capture', 'plan'], planPayload([use(adopted[0]!, 'implement')])));

    const status = await run(f, ['status', '--json']);
    const missed = status.applicable_not_selected as unknown as {
      entries: unknown[];
      limits: { kind: string; detail: string }[];
      statement: string;
    };
    expect(missed.statement).toContain('of at least 50 applicable');
    expect(missed.statement).toContain('capped at 50');
    expect(missed.limits.map((limit) => limit.kind)).toContain('identity_count');
  });

  it('renders no-rule-found beside a coverage claim of not processed, never as a statement that none exists', async () => {
    const f = await installed();
    const adopted = await adoptedRequirement(f.writer, {
      projectId: f.authority.projectId,
      statement: OFFLINE,
    });

    const answer = (await lookupJson(f, adopted)) as unknown as LookupAnswer;
    expect(answer.coverage.processing?.claim).toBe('not_processed');

    // A question this history holds no adopted rule for: the answer is empty, and the rendered
    // text that goes with it withholds the completeness claim an agent would need to say that no
    // requirement applies.
    const rendered = await runText(f, [
      'knowledge',
      'lookup',
      'retention of build artifacts on shared runners',
    ]);
    expect(rendered).toContain('Applicable (0): no adopted rule of this read applies here.');
    expect(rendered).toContain('Coverage: not processed.');
    expect(rendered).toContain('claims no completeness');
    expect(rendered).not.toContain('Coverage: complete.');
  });
});
