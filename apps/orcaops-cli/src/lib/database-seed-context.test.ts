import { describe, expect, it, vi } from 'vitest';

import { resolveDatabaseSeedCommandContext } from './database-seed-context.js';

const issue = {
  code: 'HISTORY_FORMAT_UNSUPPORTED',
  project_id: 'project-1',
  message: 'Use a build that supports this history format',
};

vi.mock('./database-history-context.js', () => ({
  resolveDatabaseHistoryCommandContext: vi.fn(async () => ({
    scope: {
      projects: [
        {
          projectId: 'project-1',
          authority: null,
          database: null,
          completeness: { complete: false, issues: [issue] },
        },
      ],
      gitContext: null,
      close: () => {},
    },
    config: { redact: { allow: [] } },
  })),
}));

describe('resolveDatabaseSeedCommandContext', () => {
  it("refuses unavailable project history with the first issue's own message", async () => {
    await expect(
      resolveDatabaseSeedCommandContext({ write: false, env: {} })
    ).rejects.toMatchObject({ code: issue.code, message: issue.message });
  });
});
