import { describe, expect, it } from 'vitest';

import { summarizeSessionTokens } from './format.js';

describe('session token summaries', () => {
  it('keeps delimiter-like agent and session identities distinct', () => {
    expect(
      summarizeSessionTokens([
        { agent: 'a:b', session_id: 'c', status: 'exact', tokens: 10 },
        { agent: 'a', session_id: 'b:c', status: 'incomplete', tokens: 20 },
      ])
    ).toEqual({ status: 'incomplete', tokens: 30, sessions: 2 });
  });
});
