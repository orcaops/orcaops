import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { uuidv7 } from '@orcaops/storage';
import type { ProjectDatabase } from '@orcaops/storage/history/database';

import { instructionSource } from '../helpers/knowledge-records.js';
import { scenarioWorkflow, type ScenarioWorkflow } from '../helpers/scenario-workflow.js';

/**
 * The snapshot-bound observation, end to end: whether any command a person can run produces one.
 *
 * `runObservedProcess` is the only thing that may mint a runner-established execution, so the
 * workflow the plan asks for — equal before and after hashes around a process that consumed
 * nothing, then a real process that read its input — can only be driven through a surface that
 * calls it. This file establishes that none does, and then drives the surface that does exist to
 * the boundary it stops at.
 */
const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..'
);

/** Where the seam is declared: its own `export async function` line is not a call of it. */
const SEAM = path.join(
  'packages',
  'storage',
  'src',
  'history',
  'database',
  'knowledge-observed-run.ts'
);

const SOURCE_TREES = ['apps', 'packages'];
const SKIPPED_DIRECTORIES = new Set(['node_modules', 'dist', 'coverage', '.turbo', 'tests']);
const SOURCE_FILE = /\.(?:ts|mts|mjs|js)$/u;
const TEST_FILE = /(?:\.test\.[^.]+|\.test-support\.ts)$/u;

/** Every file a shipped surface could be: every workspace source file that is not a test. */
async function shippedSourceFiles(): Promise<string[]> {
  const files: string[] = [];
  for (const tree of SOURCE_TREES) {
    for (const entry of await readdir(path.join(REPO_ROOT, tree), {
      recursive: true,
      withFileTypes: true,
    })) {
      if (!entry.isFile()) continue;
      const relative = path.relative(REPO_ROOT, path.join(entry.parentPath, entry.name));
      if (relative.split(path.sep).some((segment) => SKIPPED_DIRECTORIES.has(segment))) continue;
      if (!SOURCE_FILE.test(entry.name) || TEST_FILE.test(entry.name)) continue;
      if (relative !== SEAM) files.push(relative);
    }
  }
  return files;
}

const AT = '2026-09-18T09:00:00.000Z';
const CONSUMED = { kind: 'file', identity: `plan.md@sha256:${'a'.repeat(64)}` };

let workflow: ScenarioWorkflow;
let writer: ProjectDatabase;
let sourceId: string;

const observationCount = (): number =>
  writer.read(
    (view) => view.get<{ n: number }>('SELECT count(*) AS n FROM knowledge_observations')!.n
  ).value;

/** The observation document, with the fields every case here shares already in it. */
const documentFile = (record: Record<string, unknown>): Promise<string> =>
  workflow.inputDocument({
    observation_id: uuidv7(),
    source_id: sourceId,
    observed_by: { identity: 'claude-code', basis: 'other_assertion' },
    method: { name: 'vitest', configuration_sha256: null },
    outcome: 'passed',
    detail: null,
    retained_artifacts: [],
    started_at: AT,
    finished_at: AT,
    limits: [],
    ...record,
  });

beforeAll(async () => {
  workflow = await scenarioWorkflow({ database: true });
  await workflow.writeConfig({
    schema_version: 6,
    install: { scope: 'project' },
    llm: { tool: 'none' },
  });
  writer = await workflow.open();
  sourceId = await instructionSource(writer, 'The suite passed on this machine.');
}, 120_000);

afterAll(async () => {
  await workflow.cleanup();
});

describe('the observed process', { timeout: 180_000 }, () => {
  it('has no caller outside tests, so nothing shipped claims actual input consumption', async () => {
    const callers: string[] = [];
    for (const file of await shippedSourceFiles()) {
      const text = await readFile(path.join(REPO_ROOT, file), 'utf8');
      if (/\brunObservedProcess\s*\(/u.test(text)) callers.push(file);
    }

    expect(callers).toEqual([]);
  });

  it('refuses an execution a caller merely wrote down, and writes no observation for it', async () => {
    const before = observationCount();

    const refused = await workflow.run([
      'knowledge',
      'observe',
      '--json',
      '--input',
      await documentFile({
        execution: {
          kind: 'runner_established',
          runner: 'equal tree hashes around the process',
          consumed_inputs: [CONSUMED],
        },
        input_basis: 'snapshot_bound',
        known_inputs: [CONSUMED],
      }),
    ]);

    expect(refused.exitCode).toBe(1);
    expect(JSON.parse(refused.stdout)).toMatchObject({
      ok: false,
      error: {
        code: 'INVALID_INPUT',
        message: expect.stringContaining('takes a runner that hands them over'),
      },
    });
    expect(observationCount()).toBe(before);
  });

  it('records what was reported with an unknown basis, naming no input it consumed', async () => {
    const before = observationCount();

    const recorded = await workflow.json([
      'knowledge',
      'observe',
      '--json',
      '--input',
      await documentFile({
        execution: { kind: 'agent_reported', command: 'pnpm vitest run offline-capture' },
        input_basis: 'unknown',
        known_inputs: [],
        limits: ['nothing checked which files the suite opened'],
      }),
    ]);

    expect(recorded.observation_id).toMatch(/^[0-9a-f-]{36}$/u);
    expect(observationCount()).toBe(before + 1);
    expect(
      writer.read((view) =>
        view.get<{ executionKind: string; inputBasis: string }>(
          `SELECT execution_kind AS executionKind, input_basis AS inputBasis
             FROM knowledge_observations WHERE observation_id=?`,
          recorded.observation_id as string
        )
      ).value
    ).toEqual({ executionKind: 'agent_reported', inputBasis: 'unknown' });
  });
});
