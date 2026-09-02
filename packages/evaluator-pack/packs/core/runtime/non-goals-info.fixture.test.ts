import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { runFixture } from '@orcaops/evaluator-sdk';
import { makeContext } from '@orcaops/evaluator-sdk';

const here = path.dirname(fileURLToPath(import.meta.url));
const packRoot = path.resolve(here, '../../../dist/packs/core');

/**
 * non-goals-info NEVER emits a violation envelope — it's an info-
 * severity evaluator that surfaces declared non-goals for human
 * review when no LLM is available. The fixture suite covers the two
 * branches (empty vs populated non_goals) but both are pass cases.
 */
describe('non-goals-info (runFixture)', () => {
  it('pass: no non-goals declared (INFO body notes none)', async () => {
    const ctx = makeContext({
      evaluator_ref: 'core/non-goals-info',
      phase: 'checkpoint-close',
    });
    const r = await runFixture({
      command: ['node', './runtime/non-goals-info.js'],
      cwd: packRoot,
      context: ctx,
    });
    expect(r.exitCode).toBe(0);
    expect(r.envelope.verdict).toBe('pass');
    expect(r.envelope.body).toMatch(/No non-goals captured/);
  });

  it('pass: non-goals populated (INFO body lists them for human review)', async () => {
    const ctx = makeContext({
      evaluator_ref: 'core/non-goals-info',
      phase: 'checkpoint-close',
      plan: {
        ...makeContext().plan,
        non_goals: [
          { text: 'do not change the auth middleware', rationale: 'out of scope', source_refs: [] },
          { text: 'no schema migration', rationale: 'out of scope', source_refs: [] },
        ],
      },
    });
    const r = await runFixture({
      command: ['node', './runtime/non-goals-info.js'],
      cwd: packRoot,
      context: ctx,
    });
    expect(r.exitCode).toBe(0);
    expect(r.envelope.verdict).toBe('pass');
    expect(r.envelope.body).toMatch(/do not change the auth middleware/);
    expect(r.envelope.body).toMatch(/no schema migration/);
  });
});
