import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { uuidv7 } from '@orcaops/storage';
import { readProjectArtifact } from '@orcaops/storage/history/database';
import { inputFile } from '@orcaops/test-harness';

import { fixture, inventory } from '../helpers/database-history.js';
import { makeAgent } from '../support/test-agent.js';

/**
 * Ported by meaning from tests/integration/capture-secret-refusal.test.ts: a refuse-tier
 * credential in ANY switched capture verb is refused before the artifact is even looked
 * up and leaves no state, warn-tier text rides the success envelope instead of blocking,
 * and an exactly allowlisted string is exempt. The allowlist-loading contract differs
 * under the switched commands and is asserted as it actually behaves, not as the file era
 * behaved — see the note on the last case.
 */
const FAKE_TOKEN = `ghp_${'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'.slice(0, 36)}`;
const QUOTED_CODE = 'const token: HeldToken = { lockPath, live: true };';
type Fixture = Awaited<ReturnType<typeof fixture>>;
function agent(f: Fixture) {
  return makeAgent({
    cwd: f.main,
    timeoutMs: 90_000,
    env: {
      ORCAOPS_ROOT: f.main,
      ORCAOPS_DATA_DIR: f.root,
      ORCAOPS_DISABLE_DRAIN: '1',
      CODEX_SESSION_ID: 'secret-session',
      CLAUDE_SESSION_ID: '',
      CLAUDE_CODE_SESSION_ID: '',
      TMUX_PANE: '',
      STY: '',
      WINDOW: '',
      TTY: '',
      XDG_STATE_HOME: `${f.temporary}/state-secret`,
    },
  });
}
async function run(
  f: Fixture,
  verb: string[],
  body: Record<string, unknown>,
  flags = ['--no-llm']
) {
  const raw = await agent(f).runRaw([
    'capture',
    ...verb,
    ...flags,
    '--input',
    inputFile(JSON.stringify(body)),
  ]);
  return { raw, result: JSON.parse(raw.stdout) };
}
async function writeAllowlist(f: Fixture, contents: string) {
  await mkdir(path.join(f.main, '.orcaops'), { recursive: true });
  await writeFile(path.join(f.main, '.orcaops', 'config.json'), contents, 'utf8');
}

describe('registered database capture secret refusal', { timeout: 180_000 }, () => {
  it('refuses a credential in every switched verb before it touches the artifact', async () => {
    const f = await fixture();
    const id = await f.capture();
    const plan = readProjectArtifact(f.writer, id)!.thread.plan!;
    await f.mutate(id, { open: true }, (semantics) =>
      semantics.writeCheckpointOpened(
        { artifact_id: id, declared_step_ids: [plan.plan_steps[0].step_id] },
        { idempotencyKey: uuidv7(), headSha: f.context.headOid! }
      )
    );
    const before = await inventory(f.temporary);
    const cases: Array<{ verb: string[]; body: Record<string, unknown>; flags?: string[] }> = [
      {
        verb: ['plan'],
        body: {
          idempotency_key: `plan-${randomUUID()}`,
          task: `deploy with ${FAKE_TOKEN}`,
          label: 'Secret in the task',
          plan_steps: [{ text: 'wire the deploy', label: 'Wire' }],
          touched_scope: [],
          non_goals: [],
        },
      },
      {
        verb: ['plan', 'revise'],
        body: {
          idempotency_key: `revise-${randomUUID()}`,
          artifact_id: id,
          label: 'Secret in the rationale',
          rationale: `rotate ${FAKE_TOKEN}`,
          prior_plan_event_id: null,
          plan_steps: [
            {
              step_id: plan.plan_steps[0].step_id,
              text: 'Read retained evidence',
              label: 'Retained evidence',
            },
          ],
          touched_scope: [],
          non_goals: [],
        },
      },
      {
        verb: ['checkpoint', 'close'],
        body: {
          idempotency_key: `close-${randomUUID()}`,
          artifact_id: id,
          n: 1,
          summary: `closed after rotating ${FAKE_TOKEN}`,
          files_changed: [],
          completed_step_ids: [],
          decisions: [],
          uncertainty: [],
          done_criteria: [],
        },
      },
      {
        verb: ['checkpoint', 'abandon'],
        body: {
          idempotency_key: `abandon-${randomUUID()}`,
          artifact_id: id,
          n: 1,
          reason: `abandoned because ${FAKE_TOKEN} leaked`,
        },
        flags: [],
      },
      {
        verb: ['summary'],
        body: {
          idempotency_key: `sum-${randomUUID()}`,
          artifact_id: id,
          outcome: `shipped with ${FAKE_TOKEN}`,
        },
        flags: [],
      },
    ];
    for (const entry of cases) {
      const refused = await run(f, entry.verb, entry.body, entry.flags ?? ['--no-llm']);
      expect(refused.raw.exitCode, `${entry.verb.join(' ')}: ${refused.raw.stdout}`).toBe(1);
      expect(refused.result.error.code, entry.verb.join(' ')).toBe('SECRET_IN_PAYLOAD');
      expect(refused.raw.stdout).not.toContain(FAKE_TOKEN);
    }
    expect(await inventory(f.temporary)).toEqual(before);
  });

  it('accepts warn-tier text and reports it, and exempts an exactly allowlisted string', async () => {
    const f = await fixture();
    const warned = await run(f, ['plan'], {
      idempotency_key: `plan-${randomUUID()}`,
      task: 'assert the response shape',
      label: 'Warn-tier quoted code',
      plan_steps: [{ text: `refactor ${QUOTED_CODE}`, label: 'Refactor' }],
      touched_scope: [],
      non_goals: [],
    });
    expect(warned.raw.exitCode, warned.raw.stdout + warned.raw.stderr).toBe(0);
    expect(warned.result.ok).toBe(true);
    expect(warned.result.secret_warnings).toHaveLength(1);
    expect(warned.result.secret_warnings[0].patterns).toContain('generic-assignment');

    await writeAllowlist(f, JSON.stringify({ schema_version: 6, redact: { allow: [FAKE_TOKEN] } }));
    const exempt = await run(f, ['plan'], {
      idempotency_key: `plan-${randomUUID()}`,
      task: `deploy with ${FAKE_TOKEN}`,
      label: 'Allowlisted credential',
      plan_steps: [{ text: 'wire the deploy', label: 'Wire' }],
      touched_scope: [],
      non_goals: [],
    });
    expect(exempt.raw.exitCode, exempt.raw.stdout + exempt.raw.stderr).toBe(0);
    expect(exempt.result.ok).toBe(true);
  });

  it('refuses loudly rather than warning when the allowlist itself cannot be read', async () => {
    const f = await fixture();
    await writeAllowlist(f, 'schema: [');
    const refused = await run(f, ['plan'], {
      idempotency_key: `plan-${randomUUID()}`,
      task: `deploy with ${FAKE_TOKEN}`,
      label: 'Unreadable allowlist',
      plan_steps: [{ text: 'wire the deploy', label: 'Wire' }],
      touched_scope: [],
      non_goals: [],
    });
    // A switched capture loads its config through the history context rather than the
    // file-era best-effort allowlist reader, so a config that does not parse is a typed
    // refusal instead of a stderr warning beside an empty allowlist. Either way the
    // credential never passes, and the config bytes are never echoed back.
    expect(refused.raw.exitCode).toBe(1);
    expect(refused.result.ok).toBe(false);
    expect(refused.raw.stdout + refused.raw.stderr).not.toContain(FAKE_TOKEN);
  });
});
