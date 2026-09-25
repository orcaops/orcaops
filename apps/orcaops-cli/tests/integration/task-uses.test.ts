import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { taskUsesListAction, taskUsesRecordAction } from '../../src/commands/task-uses.js';
import { CliExit } from '../../src/io/exit.js';
import { runInInvocationContext } from '../../src/lib/invocation-context.js';
import { fixture } from '../helpers/database-history.js';
import { adoptedRequirement, AT, planEventOf } from '../helpers/knowledge-records.js';

type Fixture = Awaited<ReturnType<typeof fixture>>;

const OFFLINE = 'Local capture works with no Cloud connection.';

let stdout: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  stdout = [];
});

async function project(): Promise<Fixture> {
  const value = await fixture();
  await mkdir(path.join(value.main, '.orcaops'), { recursive: true });
  await writeFile(
    path.join(value.main, '.orcaops', 'config.json'),
    JSON.stringify({ schema_version: 6, install: { scope: 'project' }, llm: { tool: 'none' } }),
    'utf8'
  );
  return value;
}

async function run(
  value: Fixture,
  action: () => Promise<void>
): Promise<{ text: string; payload: Record<string, unknown>; failed: boolean }> {
  stdout = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdout.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  let failed = false;
  try {
    await runInInvocationContext(
      {
        cwd: value.main,
        env: {
          ...process.env,
          ORCAOPS_ROOT: value.main,
          ORCAOPS_DATA_DIR: value.root,
          ORCAOPS_DISABLE_DRAIN: '1',
        },
      },
      action
    );
  } catch (err) {
    if (!(err instanceof CliExit)) throw err;
    failed = true;
  }
  const text = stdout.join('');
  const payload = text.startsWith('{') ? (JSON.parse(text) as Record<string, unknown>) : {};
  return { text, payload, failed };
}

async function taskAndRule(value: Fixture) {
  const artifactId = await value.capture();
  const planEventId = planEventOf(value.writer, artifactId);
  const adopted = await adoptedRequirement(value.writer, {
    projectId: value.authority.projectId,
    statement: OFFLINE,
  });
  return { artifactId, planEventId, adopted };
}

describe('orcaops task uses', { timeout: 120_000 }, () => {
  it('refuses a use that cannot say who found the connection and when', async () => {
    const value = await project();
    const { artifactId, planEventId, adopted } = await taskAndRule(value);

    const { payload, failed } = await run(value, () =>
      taskUsesRecordAction({
        artifact: artifactId,
        planEvent: planEventId,
        identity: `requirement:${adopted.requirementId}`,
        revision: adopted.revisionId,
        role: 'preserve',
        json: true,
      })
    );

    expect(failed).toBe(true);
    expect(payload).toMatchObject({ ok: false, error: { code: 'DISCOVERY_REQUIRED' } });
    const listed = await run(value, () =>
      taskUsesListAction({ planEvent: planEventId, json: true })
    );
    expect(listed.payload.plan_events).toMatchObject([
      { plan_event_id: planEventId, selected_with_plan: [], connected_later: [] },
    ]);
  });

  it('records the basis this command can state, never the one a payload asks for', async () => {
    const value = await project();
    const { artifactId, planEventId, adopted } = await taskAndRule(value);
    const payloadPath = path.join(value.main, 'use.json');
    await writeFile(
      payloadPath,
      JSON.stringify({
        uses: [
          {
            artifact_id: artifactId,
            plan_event_id: planEventId,
            target: {
              kind: 'requirement',
              entity_id: adopted.requirementId,
              revision_id: adopted.revisionId,
            },
            role: 'preserve',
            local: null,
            exception_id: null,
          },
        ],
        discovery: {
          discovered_at: AT,
          discovered_by: { kind: 'actor', actor: { identity: 'the-cto', basis: 'authenticated' } },
        },
      }),
      'utf8'
    );

    const recorded = await run(value, () =>
      taskUsesRecordAction({ input: payloadPath, json: true })
    );
    expect(recorded.failed).toBe(false);

    const listed = await run(value, () =>
      taskUsesListAction({ planEvent: planEventId, json: true })
    );
    const discoveredBy = (
      listed.payload.plan_events as {
        connected_later: { discovered_by: { kind: string; name: string; basis: string } }[];
      }[]
    )[0]!.connected_later[0]!.discovered_by;
    // The payload supplies the name; the basis is the command's, and nothing local can
    // authenticate a name.
    expect(discoveredBy.name).toBe('the-cto');
    expect(discoveredBy.basis).not.toBe('authenticated');
    expect(['other_assertion', 'agent_reported_user_instruction']).toContain(discoveredBy.basis);
  });

  it('records a use with its discovery, and renders it under connected later', async () => {
    const value = await project();
    const { artifactId, planEventId, adopted } = await taskAndRule(value);

    const recorded = await run(value, () =>
      taskUsesRecordAction({
        artifact: artifactId,
        planEvent: planEventId,
        identity: `requirement:${adopted.requirementId}`,
        revision: adopted.revisionId,
        role: 'preserve',
        discoveredAt: AT,
        discoveredBy: 'owner',
        json: true,
      })
    );

    expect(recorded.failed).toBe(false);
    expect(recorded.payload.uses).toMatchObject([
      { selection_kind: 'connected_later', published: true, role: 'preserve' },
    ]);

    const listed = await run(value, () =>
      taskUsesListAction({ planEvent: planEventId, json: true })
    );
    expect(listed.payload.plan_events).toMatchObject([
      {
        plan_event_id: planEventId,
        selected_with_plan: [],
        connected_later: [
          {
            target: { entityId: adopted.requirementId, revisionId: adopted.revisionId },
            role: 'preserve',
            discovered_at: AT,
            discovered_by: { kind: 'actor', name: 'owner' },
          },
        ],
      },
    ]);

    const rendered = await run(value, () => taskUsesListAction({ planEvent: planEventId }));
    expect(rendered.failed).toBe(false);
    expect(rendered.text).toContain('Selected with the plan (0): this plan selected none.');
    expect(rendered.text).toContain('Connected later (1)');
    expect(rendered.text).toContain('found by owner (actor;');
  });
});
