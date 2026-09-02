import { describe, expect, it, vi } from 'vitest';

import { TrpcRequestError } from '@orcaops/sdk';
import type { SourcePlanReviewerDiscoveryResponse } from '@orcaops/sdk';

import { formatHumanReviewers, type ReviewersClient, runReviewReviewers } from './reviewers.js';

function roster(
  over: Partial<SourcePlanReviewerDiscoveryResponse> = {}
): SourcePlanReviewerDiscoveryResponse {
  return {
    members: [
      { handle: 'alice@example.dev', name: 'Alice Apple' },
      { handle: 'bob@example.dev', name: 'Bob Banana' },
    ],
    scope: 'all_members',
    ...over,
  };
}

function client(listReviewers: ReviewersClient['sourcePlan']['listReviewers']): ReviewersClient {
  return { sourcePlan: { listReviewers } };
}

describe('runReviewReviewers', () => {
  it('always sends the canonicalized repo_url (null when unresolvable)', async () => {
    const listReviewers = vi.fn(async () => roster());
    await runReviewReviewers({
      client: client(listReviewers),
      repoUrl: 'https://github.com/foo/bar',
    });
    expect(listReviewers).toHaveBeenCalledExactlyOnceWith({
      schema_version: 1,
      repo_url: 'https://github.com/foo/bar',
    });

    const bare = vi.fn(async () => roster());
    await runReviewReviewers({ client: client(bare), repoUrl: null });
    expect(bare).toHaveBeenCalledWith(expect.objectContaining({ repo_url: null }));
  });

  it('maps a missing procedure to the DISCOVERY-specific skew message', async () => {
    const listReviewers = vi.fn(async () => {
      throw new TrpcRequestError('anything', {
        code: 'NOT_FOUND',
        httpStatus: 404,
        appCode: 'UNKNOWN_PROCEDURE',
      });
    });
    const err = await runReviewReviewers({ client: client(listReviewers), repoUrl: null }).then(
      () => null,
      (e: unknown) => e
    );
    expect(err).toMatchObject({ code: 'NO_INPUT' });
    expect((err as Error).message).toMatch(/doesn't expose reviewer discovery/);
    // NOT the generic surface message — the rest of the review surface exists.
    expect((err as Error).message).not.toMatch(/doesn't expose the plan-review surface/);
  });

  it('passes non-NOT_FOUND errors through unchanged (CLOUD_ERROR-bound)', async () => {
    const boom = new TrpcRequestError('boom', { code: 'INTERNAL_SERVER_ERROR', httpStatus: 500 });
    const err = await runReviewReviewers({
      client: client(
        vi.fn(async () => {
          throw boom;
        })
      ),
      repoUrl: null,
    }).then(
      () => null,
      (e: unknown) => e
    );
    expect(err).toBe(boom);
  });
});

describe('formatHumanReviewers', () => {
  it('renders handle + name rows and the all-members scope note', () => {
    const out = formatHumanReviewers(roster());
    expect(out).toContain('Reviewers (2)');
    expect(out).toContain('alice@example.dev');
    expect(out).toContain('Alice Apple');
    expect(out).toContain('Scope: all org members');
    expect(out).toContain('--reviewer <handle>');
  });

  it('renders the repo-configured scope note', () => {
    const out = formatHumanReviewers(roster({ scope: 'repo_configured' }));
    expect(out).toContain('Scope: reviewers configured for this repo.');
  });

  it('renders an unknown future scope raw (permissive by design)', () => {
    const out = formatHumanReviewers(roster({ scope: 'team_leads' }));
    expect(out).toContain('Scope: team_leads');
  });

  it('renders an empty roster without throwing', () => {
    const out = formatHumanReviewers(roster({ members: [] }));
    expect(out).toContain('Reviewers (0)');
    expect(out).toContain('(none)');
  });
});
