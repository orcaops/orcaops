import { afterEach, describe, expect, it, vi } from 'vitest';

import { resolveDatabaseHistoryScope } from '@orcaops/project-scope/history/database';
import { getDefaultConfig, uuidv7 } from '@orcaops/storage';

import {
  type DatabaseStepBriefOptions,
  formatDatabaseStepBrief,
  readDatabaseStepBrief,
  validateDatabaseStepBrief,
} from './database-step.js';
import { fixture, inventory } from '../../tests/helpers/database-history.js';
import { createDatabaseStepBriefAction } from '../commands/step.js';
import { CliExit } from '../io/exit.js';

const readers = new Set<{ close(): void }>();
afterEach(() => {
  for (const reader of readers) reader.close();
  readers.clear();
  vi.restoreAllMocks();
});
async function context(
  f: Awaited<ReturnType<typeof fixture>>,
  options: ReturnType<typeof validateDatabaseStepBrief>
) {
  const scope = await resolveDatabaseHistoryScope({
    root: f.root,
    cwd: f.main,
    profile: options.profile,
    selector: options.selector,
  });
  readers.add(scope);
  return { scope, config: getDefaultConfig() };
}
const legacyStep = 'original non-UUID step';
function steps(ids: string[]) {
  return ids.map((step_id, index) => ({
    step_id,
    text: `Retain step ${index + 1}`,
    label: `Retain step ${index + 1}`,
    acceptance_criteria: [],
  }));
}

describe('database step brief options', () => {
  it('rejects missing identifiers, retired flags and invalid selectors before opening history', async () => {
    const openContext = vi.fn();
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const action = createDatabaseStepBriefAction({ openContext });
    for (const [stepId, options] of [
      ['', {}],
      ['   ', {}],
      ['a\0b', {}],
      [7, {}],
      ['step', null],
      ['step', []],
      ['step', { allProjects: true }],
      ['step', { scope: 'project' }],
      ['step', { branch: 'main' }],
      ['step', { project: 'bad' }],
      ['step', { artifact: 'bad!' }],
      ['step', { artifact: 7 }],
      ['step', { json: 'yes' }],
    ] as const)
      await expect(
        action(stepId as string, options as DatabaseStepBriefOptions)
      ).rejects.toBeInstanceOf(CliExit);
    expect(openContext).not.toHaveBeenCalled();
  });

  it('serves the artifact selection copied before its context resolved, not later caller mutations', async () => {
    const f = await fixture();
    const first = await f.capture(undefined, { steps: steps([legacyStep]) });
    const second = await f.capture(undefined, { steps: steps([legacyStep]) });
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    let resolve!: (value: Awaited<ReturnType<typeof context>>) => void;
    const opened = new Promise<Awaited<ReturnType<typeof context>>>((done) => {
      resolve = done;
    });
    const openContext = vi.fn((options: ReturnType<typeof validateDatabaseStepBrief>) => {
      void context(f, options).then(resolve);
      return opened;
    });
    const options: DatabaseStepBriefOptions = { artifact: first, json: true };
    const pending = createDatabaseStepBriefAction({ openContext })(legacyStep, options);
    options.artifact = second;
    options.json = false;
    await pending;
    const result = JSON.parse(String(stdout.mock.calls[0][0])) as ReturnType<
      typeof readDatabaseStepBrief
    >;
    expect(result.artifact_id).toBe(first);
    expect(result.candidates).toEqual([first, second].sort());
  });

  it('refuses a context that differs from the validated project', async () => {
    const f = await fixture();
    const id = await f.capture();
    const ctx = await context(f, validateDatabaseStepBrief('step', {}));
    expect(() => readDatabaseStepBrief(ctx, 'step', { project: uuidv7() })).toThrow(
      expect.objectContaining({ code: 'SCOPE_CONFLICT' })
    );
    expect(id).toBeTruthy();
  });
});

describe('database step brief composition', { timeout: 30_000 }, () => {
  it('selects among artifacts containing the step by exact identity or unique prefix', async () => {
    const f = await fixture();
    const a = await f.capture(undefined, { steps: steps([legacyStep, uuidv7()]) });
    const b = await f.capture(undefined, { steps: steps([legacyStep]) });
    const ctx = await context(f, validateDatabaseStepBrief(legacyStep, {}));
    const before = await inventory(f.temporary);
    expect(() => readDatabaseStepBrief(ctx, legacyStep)).toThrow(
      expect.objectContaining({
        code: 'AMBIGUOUS_ARTIFACT',
        context: expect.objectContaining({
          candidates: [a, b].sort().map((artifact_id) => ({
            project_id: f.authority.projectId,
            artifact_id,
            command: `orcaops step brief ${legacyStep} --artifact ${artifact_id} --project ${f.authority.projectId}`,
          })),
        }),
      })
    );
    const exact = readDatabaseStepBrief(ctx, legacyStep, { artifact: a });
    expect(exact).toMatchObject({
      schema_version: 3,
      project_id: f.authority.projectId,
      artifact_id: a,
      origin: null,
      step: { step_id: legacyStep, dropped_in_latest_revision: false, last_present_revision_n: 0 },
      claim_state: { state: 'unclaimed' },
      candidates: [a, b].sort(),
      source_version: { artifact: { generation: 1 }, execution: 1 },
      integrity: { selection: 'verified-revisions' },
    });
    expect(exact.siblings).toHaveLength(1);
    const [unique, other] = [a, b].sort();
    const shortest = [...Array(unique.length).keys()]
      .map((length) => unique.slice(0, length + 1))
      .find((candidate) => !other.startsWith(candidate))!;
    expect(readDatabaseStepBrief(ctx, legacyStep, { artifact: shortest }).artifact_id).toBe(unique);
    expect(() => readDatabaseStepBrief(ctx, legacyStep, { artifact: uuidv7() })).toThrow(
      expect.objectContaining({ code: 'INVALID_INPUT', inputPath: 'artifact' })
    );
    expect(() => readDatabaseStepBrief(ctx, uuidv7())).toThrow(
      expect.objectContaining({ code: 'INVALID_INPUT', inputPath: 'step_id' })
    );
    expect(formatDatabaseStepBrief(exact)).toContain(`candidates:   ${[a, b].sort().join(', ')}`);
    expect(await inventory(f.temporary)).toEqual(before);
  });
});
