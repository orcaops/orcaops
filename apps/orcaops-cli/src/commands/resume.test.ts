import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDatabaseResumeAction } from './resume.js';
import { CliExit } from '../io/exit.js';

vi.mock('../lib/database-resume.js', () => ({
  validateDatabaseResume: () => ({ options: {}, selector: {} }),
  readDatabaseResume: vi.fn(async () => ({
    resolved: false,
    schema_version: 3,
    reason: 'HISTORY_SELECTION_INCOMPLETE',
    artifact: null,
    candidates: [],
    focus: null,
    history: {
      complete: false,
      issues: [
        {
          code: 'HISTORY_FORMAT_UNSUPPORTED',
          project_id: 'project-1',
          message: 'Use a build that supports this history format',
        },
      ],
    },
    next_actions: [],
  })),
}));
vi.mock('../lib/database-task-advisories.js', () => ({
  readTaskAdvisories: vi.fn(async () => ({ acknowledgeByRef: () => false, drift: null })),
}));

describe('resume human output', () => {
  afterEach(() => vi.restoreAllMocks());

  it('lists the history issues that left no task selected', async () => {
    const written: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      written.push(String(chunk));
      return true;
    });
    const action = createDatabaseResumeAction({
      openContext: async () =>
        ({
          scope: { close: () => {} },
          config: { digest: { redact_secrets: false } },
        }) as never,
    });

    await expect(action({})).rejects.toBeInstanceOf(CliExit);
    const out = written.join('');
    expect(out).toContain('No task selected: HISTORY_SELECTION_INCOMPLETE.');
    expect(out).toContain(
      '  project-1: HISTORY_FORMAT_UNSUPPORTED: Use a build that supports this history format'
    );
  });
});
