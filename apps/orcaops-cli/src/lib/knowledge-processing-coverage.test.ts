import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { processingCoverageOf } from './knowledge-processing-coverage.js';
import type { ProcessingHistory } from './knowledge-processing-queue.js';

const SOURCE = 'src/lib/knowledge-processing-coverage.ts';
const cliRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const READY = {
  status: 'ready',
  configuration: {},
} as unknown as Parameters<typeof processingCoverageOf>[0]['resolution'];

const history = (change: Partial<ProcessingHistory> = {}): ProcessingHistory => ({
  problem: null,
  backlog: { paused_jobs: 0, latest_admitted_sequence: 12 },
  queue: {
    jobs: { pending: 1, running: 0, completed: 2, retryable_failure: 1, terminal_failure: 1 },
    waiting: [{ waitReason: 'provider_unavailable', jobs: 2, nextRetryAt: null }],
    awaitingModelResume: 1,
    openAttempts: 0,
    latestAdmittedSequence: 12,
    eligibleSources: 3,
    missingEligibleSources: 0,
    latestEligibleSequence: 12,
  },
  control: null,
  lease: null,
  usage: null,
  gaveUp: null,
  target: null,
  boundary: 20,
  ...change,
});

const coverage = (change: Partial<ProcessingHistory> = {}) =>
  processingCoverageOf({
    enabled: true,
    source: { kind: 'worktree', path: '/repo/.orcaops/config.json' },
    resolution: READY,
    history: history(change),
    consent: { ok: true, grant_id: 'grant-1' },
  });

describe('the processing coverage every surface reads', () => {
  it('counts the queue the way both surfaces print it', () => {
    expect(coverage().jobs).toEqual({
      open: 2,
      waiting: 2,
      awaiting_model_resume: 1,
      completed: 2,
      gave_up: 1,
    });
    expect(coverage().latest_admitted_sequence).toBe(12);
    expect(coverage().boundary).toBe(20);
  });

  it('reads the claim against the boundary the answer was read at', () => {
    const result = processingCoverageOf({
      enabled: true,
      source: { kind: 'worktree', path: '/repo/.orcaops/config.json' },
      resolution: READY,
      history: history({
        queue: {
          jobs: {
            pending: 0,
            running: 0,
            completed: 3,
            retryable_failure: 0,
            terminal_failure: 0,
          },
          waiting: [],
          awaitingModelResume: 0,
          openAttempts: 0,
          latestAdmittedSequence: 12,
          eligibleSources: 3,
          missingEligibleSources: 0,
          latestEligibleSequence: 12,
        },
      }),
      consent: { ok: true, grant_id: 'grant-1' },
      boundary: 20,
    });

    expect(result.claim).toBe('complete');
    expect(result.statement).toContain('Current processing status is complete');
    expect(result.statement).toContain(
      "This answer's knowledge is independently limited to write sequence 20"
    );
    expect(result.statement).toContain(
      'interpretation output committed after that boundary may be absent'
    );
  });

  it('leaves the queue unknown when the history could not be read', () => {
    const unreadable = coverage({
      problem: { code: 'upgrade_required', message: 'Run `orcaops history upgrade`.' },
      queue: null,
    });
    expect(unreadable.jobs).toBeNull();
    expect(unreadable.claim).toBe('unknown');
  });

  it('drops the disabled pause reason, which enabled already says', () => {
    const paused = processingCoverageOf({
      enabled: false,
      source: { kind: 'worktree', path: '/repo/.orcaops/config.json' },
      resolution: {
        status: 'paused',
        source: { kind: 'worktree', path: '/repo/.orcaops/config.json' },
        provider: null,
        reasons: [
          { code: 'disabled', setting: 'enabled', message: 'It is off.' },
          { code: 'provider_unsupported', setting: 'provider', message: 'No provider.' },
        ],
      },
      history: history(),
      consent: null,
    });
    expect(paused.pause_reasons.map((reason) => reason.code)).toEqual(['provider_unsupported']);
  });
});

async function sourceFiles(): Promise<string[]> {
  const entries = await readdir(path.join(cliRoot, 'src'), {
    recursive: true,
    withFileTypes: true,
  });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => path.relative(cliRoot, path.join(entry.parentPath, entry.name)));
}

describe('who may compute what processing has interpreted', () => {
  it('is one function, and every surface that prints the claim calls it', async () => {
    for (const surface of [
      'src/commands/knowledge/status.ts',
      'src/commands/knowledge/doctor.ts',
      'src/commands/knowledge/lookup.ts',
    ]) {
      const body = await readFile(path.join(cliRoot, surface), 'utf8');
      expect(body, surface).toMatch(
        /processingCoverageOf.*from '.*knowledge-processing-coverage/su
      );
    }
  });

  it('is the only caller of the claim rule, so no second wording exists', async () => {
    const callers: string[] = [];
    for (const file of await sourceFiles()) {
      if (file === SOURCE || file.endsWith('.test.ts')) continue;
      const body = await readFile(path.join(cliRoot, file), 'utf8');
      if (body.includes('knowledgeProcessingCoverage')) callers.push(file);
    }
    expect(callers).toEqual([]);
  });
});
