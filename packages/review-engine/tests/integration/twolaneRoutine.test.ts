import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { type ProjectEvidenceFile, readProjectEvidence } from '@orcaops/storage/history/database';

import { runReview } from '../../src/run.js';
import { parseStoryReviewModel, STORY_REVIEW_MODEL_FILE } from '../../src/storyReviewModel.js';
import { capturedReviewFixture, type CapturedReviewFixture } from '../capturedReviewFixture.js';

/** An account story that claims every checkpoint the served payload lists. */
function authoredAccount(markdown: string) {
  const checkpoints = [...markdown.matchAll(/^#### (k\d+) ·/gm)].map((match) => match[1]!);
  const citation = /\[(c\d+)\]/.exec(markdown)?.[1];
  expect(checkpoints.length).toBeGreaterThan(0);
  expect(citation).toBeDefined();
  return {
    schema_version: 1,
    overview: {
      text: 'The captured checkpoints add two bounded features.',
      citations: [citation],
    },
    acts: [
      {
        title: 'Add the bounded features',
        interpretation: 'The checkpoints carry the features from intent to implementation.',
        parts: [
          {
            title: 'Captured features',
            checkpoints,
            interpretation: 'The changed files implement the captured checkpoints.',
            citations: [citation],
          },
        ],
      },
    ],
    questions: [],
  };
}

describe('two-lane routine lifecycle', () => {
  let fixture: CapturedReviewFixture | null = null;

  afterEach(async () => {
    vi.restoreAllMocks();
    await fixture?.cleanup();
    fixture = null;
  });

  it('enforces forensic-first ordering and seals the accepted Story', async () => {
    const f = await capturedReviewFixture();
    fixture = f;
    const runtime = await f.runtimeDescriptor();
    vi.stubEnv('ORCAOPS_DATA_DIR', f.dataRoot);

    const stdout: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdout.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const lastJson = (): Record<string, unknown> => {
      for (let index = stdout.length - 1; index >= 0; index -= 1) {
        const line = stdout[index]!;
        if (line.trimStart().startsWith('{')) return JSON.parse(line) as Record<string, unknown>;
      }
      throw new Error('routine command emitted no JSON');
    };
    const run = (args: string[]) =>
      runReview(
        ['review', ...args, '--branch', f.branch, '--root', f.gitRoot, '--json'],
        process.env,
        undefined,
        runtime
      );
    const writePayload = async (name: string, value: unknown): Promise<string> => {
      const file = path.join(f.root, name);
      await writeFile(file, JSON.stringify(value));
      return file;
    };
    const submit = (runId: string, lane: string, input: string) =>
      run([
        'routine-submit',
        '--run',
        runId,
        '--lane',
        lane,
        '--isolation',
        'sequential',
        '--input',
        input,
      ]);

    expect(await run(['routine-start'])).toBe(0);
    const started = lastJson();
    expect(started.lane).toBe('forensic');
    const runId = started.run_id as string;

    const premature = await writePayload('premature-account.json', {});
    expect(await submit(runId, 'account', premature)).toBe(0);
    expect(lastJson()).toMatchObject({
      accepted: false,
      diagnostics: [{ code: 'TWOLANE_ROUTINE_ORDER' }],
    });

    const forensic = await writePayload('forensic.json', {
      findings: [
        {
          claim: 'The limiter has no shared clock across processes.',
          file: 'src/limiter.ts',
          related_files: [],
          severity: 'CAUTION',
          confidence: 'HIGH',
        },
      ],
      questions: [],
    });
    expect(await submit(runId, 'forensic', forensic)).toBe(0);
    const forensicEnvelope = lastJson();
    expect(forensicEnvelope, JSON.stringify(forensicEnvelope, null, 2)).toMatchObject({
      accepted: true,
    });
    const accountEnvelope = forensicEnvelope.account as Record<string, unknown>;
    const accountPrompt = await readFile(
      path.join(f.gitRoot, accountEnvelope.payload_path as string),
      'utf8'
    );

    const account = await writePayload('account.json', authoredAccount(accountPrompt));
    expect(await submit(runId, 'account', account)).toBe(0);
    const finalized = lastJson();
    expect(finalized, JSON.stringify(finalized, null, 2)).toMatchObject({
      accepted: true,
      outcome: 'FULL',
    });
    expect(finalized.files).toEqual(
      expect.arrayContaining([
        'review.md',
        'brief.json',
        'composed-story-v2.json',
        STORY_REVIEW_MODEL_FILE,
      ])
    );

    // The Story is retained evidence under its publication, not a run directory.
    const story = await f.read(async (database) => {
      const members = database.read((view) =>
        view.all<ProjectEvidenceFile & { name: string }>(
          'SELECT name, relative_path AS relativePath, sha256, byte_length AS byteLength FROM review_evidence_members WHERE publication_id = ? ORDER BY name',
          finalized.story_publication_id as string
        )
      ).value;
      const bytes: Record<string, string> = {};
      for (const member of members)
        bytes[member.name] = (await readProjectEvidence(database, member)).toString('utf8');
      return { names: members.map((member) => member.name), bytes };
    });
    expect(story.names).toEqual([
      'brief.json',
      'composed-story-v2.json',
      'review.md',
      STORY_REVIEW_MODEL_FILE,
    ]);
    const composed = JSON.parse(story.bytes['composed-story-v2.json']!) as {
      story: { parts: { title: string }[] };
    };
    expect(composed.story.parts).toEqual([expect.objectContaining({ title: 'Captured features' })]);
    const installed = parseStoryReviewModel(JSON.parse(story.bytes[STORY_REVIEW_MODEL_FILE]!));
    expect(installed.parts).toEqual([expect.objectContaining({ title: 'Captured features' })]);

    const record = (finalized.run_record ?? {}) as { outcome?: string; submission_count?: number };
    expect(record.outcome).toBe('FULL');
    expect(record.submission_count).toBe(2);
  }, 300_000);
});
