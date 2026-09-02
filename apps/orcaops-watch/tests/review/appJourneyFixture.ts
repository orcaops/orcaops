import type { ResolveReviewTarget } from '../../src/data/reviewTarget';
import type { WatchSnapshot, WatchThread } from '../../src/data/types';

export const REVIEWABLE_JOURNEY_INDEX = 18;
/** The one fixture branch a live worktree owns; every other row is refused. */
export const REVIEWABLE_JOURNEY_BRANCH = 'probe';
export const JOURNEY_REVIEW_ROOT = '/tmp/orcaops-journey';

/**
 * Review-target resolver for the mounted journeys. Entering review resolves the
 * worktree that owns the branch off disk, which would otherwise make these
 * journeys depend on the checkout the suite happens to run in. This stands in
 * for that resolve and keeps BOTH outcomes reachable: the reviewable row opens,
 * every other row refuses with the resolver's own no-live-worktree wording.
 */
export const journeyReviewTarget: ResolveReviewTarget = ({ branch }) =>
  Promise.resolve(
    branch === REVIEWABLE_JOURNEY_BRANCH
      ? { ok: true, root: JOURNEY_REVIEW_ROOT }
      : {
          ok: false,
          reason: `cannot review ${branch} — no live worktree has it checked out; check it out first, or open its worktree`,
        }
  );

function watchThread(index: number, now: number): WatchThread {
  const reviewable = index === REVIEWABLE_JOURNEY_INDEX;
  const suffix = String(index).padStart(2, '0');
  return {
    artifactId: reviewable ? 'journey-artifact' : `background-${suffix}`,
    artifactStatus: 'active',
    source: 'hot',
    branch: reviewable ? REVIEWABLE_JOURNEY_BRANCH : `branch-${suffix}`,
    title: reviewable ? 'Premium journey fixture' : `Background fixture ${suffix}`,
    agent: 'codex',
    sessions: [],
    openCheckpoints: reviewable ? 1 : 0,
    openComments: 0,
    isCurrentCheckout: reviewable,
    currentLine: reviewable ? 'Unify the Watch and Review journey' : `Background work ${suffix}`,
    steps: reviewable ? { completed: 1, total: 3 } : null,
    lastWriteMs: now,
    lastClosed: null,
    state: 'working',
    sparkline: [0, 1, 1],
    planSteps: reviewable
      ? [
          {
            idx: 1,
            text: 'Preserve Watch state',
            label: 'Preserve Watch state',
            done: true,
            current: false,
          },
          {
            idx: 2,
            text: 'Unify Review entry',
            label: 'Unify Review entry',
            done: false,
            current: true,
          },
        ]
      : [],
    checkpoints: [],
    startedAtMs: now - 60_000,
    planDecisions: [],
    nonGoals: [],
    recentEvents: [],
  };
}

/** Deterministic Watch source shared by the mounted and real-PTY App journeys. */
export function reviewableWatchSnapshot(): WatchSnapshot {
  const now = Date.now();
  const threads = Array.from({ length: 24 }, (_, index) => watchThread(index, now));
  return {
    generated_at: new Date(now).toISOString(),
    generatedAtMs: now,
    dataRoot: '/tmp/orcaops-journey',
    archiveEnabled: false,
    totals: { activeThreads: threads.length, openCheckpoints: 1, sessionTokens: 0 },
    projects: [{ projectId: null, displayName: 'journey-project', threads }],
    ticker: [],
  };
}
