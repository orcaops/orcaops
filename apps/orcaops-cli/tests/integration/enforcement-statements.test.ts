// GUARD: every enforcement statement the documentation makes is probed here.
//
// `apps/docs/content/local-data.md` says of each authority and consent check whether Orcaops
// enforces it at a boundary, observes it, or receives it as the agent's assertion. A sentence like
// that is a promise, and a promise nobody exercises is how "enforces" quietly becomes "records".
//
// The table is the fixture: this file must probe exactly the checks it names, so a row added
// without a probe and a probe left behind by a deleted row both fail here, and the docs facts
// validator holds the same rows to the symbols they cite.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { authorityAtBoundary, type RecordedAct } from '@orcaops/core';
import { resolveNoToolCall } from '@orcaops/llm';
import { checkAuthorization } from '@orcaops/storage';

import { resolveInvokingAgent } from '../../src/lib/invoking-agent.js';
import { evaluateProcessingConsent } from '../../src/lib/knowledge-processing-consent.js';

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..'
);

const read = (repoRelative: string): string =>
  readFileSync(path.join(REPO_ROOT, repoRelative), 'utf8');

/** The `Check` column of the enforcement statement table, in the page's order. */
function statedChecks(): string[] {
  const page = read('apps/docs/content/local-data.md');
  const start = page.indexOf('## What Orcaops enforces, and what it only observes');
  const section = page.slice(start, page.indexOf('\n## ', start + 1));
  return section
    .split('\n')
    .filter((line) => line.trim().startsWith('|'))
    .map((line) => line.trim().replace(/^\|/, '').split('|')[0]!.trim())
    .filter((check) => check !== 'Check' && !/^-+$/.test(check) && check !== '');
}

const PROJECT = { kind: 'project', project_id: 'project-1' } as const;
const RULE = { kind: 'requirement', entity_id: 'offline', revision_id: 'offline-r1' } as const;
const RESPONSIBLE = { identity: 'retry-team', basis: 'other_assertion' } as const;
const ACTING = { kind: 'actor', actor: RESPONSIBLE } as const;

/** An assignment in view, delegating leave to except one rule and nothing else. */
const delegation = (overrides: Record<string, unknown> = {}) => ({
  assignment_id: 'assignment-1',
  scope: PROJECT,
  responsible: RESPONSIBLE,
  delegated: {
    adopts: [],
    departs_from: [
      { rule: RULE, how: 'excepts' as const, exception_id: 'exception-1', replaced_by: null },
    ],
    restates: [],
  },
  covers_this_work: 'applies' as const,
  valid: true,
  ...overrides,
});

const EXCEPTING = {
  adopts: [],
  departs_from: [
    { rule: RULE, how: 'excepts' as const, exception_id: 'exception-1', replaced_by: null },
  ],
  restates: [],
};

const restingOnAssignment = (footprint: unknown, acting: unknown, assignment = delegation()) =>
  checkAuthorization({
    authorization: { kind: 'assignment', assignment_id: 'assignment-1' },
    scope: PROJECT,
    footprint: footprint as never,
    acting: acting as never,
    context: { bindings: [], earlier: [], assignments: [assignment as never] },
  });

const revokedAct: RecordedAct = {
  kind: 'exception',
  id: 'exception-1',
  scope: PROJECT,
  attributed_to: 'retry-team',
  recorded_at: '2026-09-18T10:00:00.000Z',
  write_sequence: 10,
  authority: {
    kind: 'assignment',
    id: 'assignment-1',
    standing: 'revoked',
    reason: 'A revocation reaching its scope ended it.',
    revocations: [],
  },
};

const emptyAnswer = {
  basis: { scope: PROJECT, mode: 'current' as const, knowledge_boundary: 1 },
  entries: [],
  applicable: [],
  background: [],
  proposals: [],
  conflicts: [],
  unresolved: [],
  later_annotations: [],
  coverage: {
    read: {
      scope: PROJECT,
      mode: 'current' as const,
      boundary: 1,
      omitted: [],
      unresolved: [],
      later: [],
      branchScoped: [],
    },
    processing: null,
  },
  limits: [],
};

const boundaryFor = (acts: readonly RecordedAct[]) =>
  authorityAtBoundary(
    { boundary: 1, plan_write_sequence: 1, answer: emptyAnswer, acts },
    {
      artifactId: 'artifact-1',
      planEventId: 'plan-event-1',
      boundary: 'now',
      judgedAt: '2026-09-18T12:00:00.000Z',
      actingIdentity: 'retry-team',
    }
  );

const consentRequest = (grants: readonly unknown[]) => ({
  grants,
  problems: [],
  project_id: 'project-1',
  provider: 'claude' as const,
  processor_contract: 'orcaops.knowledge_processor/v1',
  effective_tool_access: 'none' as const,
  effective_limits: {
    max_calls_per_hour: 1,
    max_cost_usd_per_day: 'none' as const,
    max_cost_usd_per_call: 'none' as const,
    max_input_bytes: 1,
    max_output_bytes: 1,
  },
  job: { admitted_sequence: 1 },
});

/**
 * One probe per row of the table. `refuses` and `permits` run the boundary here; `demonstratedBy`
 * names the test that already runs it, for the boundaries this package cannot reach in process —
 * a provider subprocess and a built review payload — and the citation is checked to exist.
 */
const PROBES: Record<
  string,
  | { refuses: () => boolean }
  | { permits: () => boolean }
  | { demonstratedBy: { file: string; title: string } }
> = {
  'An assignment delegates no more than its assigner holds': {
    demonstratedBy: {
      file: 'apps/orcaops-cli/tests/integration/knowledge-assignment.test.ts',
      title:
        'refuses an assignment that delegates more than its assigner holds, and writes nothing',
    },
  },
  'An act is covered by the authority it cites': {
    refuses: () => {
      const outcome = restingOnAssignment(
        {
          adopts: [],
          departs_from: [
            { rule: RULE, how: 'withdraws' as const, exception_id: null, replaced_by: null },
          ],
          restates: [],
        },
        ACTING
      );
      return !outcome.ok && outcome.code === 'ASSIGNMENT_DOES_NOT_COVER_DEPARTURE';
    },
  },
  'A correction is covered by the authority it cites': {
    demonstratedBy: {
      file: 'packages/storage/src/history/database/knowledge-corrections.test.ts',
      title: "refuses undoing another's act with no instruction and accepts it with one in scope",
    },
  },
  'An act rests on authority that still stands when work is integrated': {
    refuses: () => boundaryFor([revokedAct]).revoked.length === 1,
  },
  'Background processing has a consent grant covering the job': {
    refuses: () => {
      const decision = evaluateProcessingConsent(consentRequest([]));
      return !decision.ok && decision.code === 'CONSENT_DENIED';
    },
  },
  'An evaluator pack has a grant covering its engine capabilities': {
    demonstratedBy: {
      file: 'apps/orcaops-cli/src/lib/evaluator-grants.test.ts',
      title: 'coverage requires the source identity and every requested capability',
    },
  },
  'A per-call spend cap the provider can hold as a ceiling': {
    refuses: () =>
      resolveNoToolCall({ provider: 'claude', explicitMaxCostUsd: 1 }).status === 'unavailable',
  },
  'The daily spend budget and the hourly call allowance': {
    demonstratedBy: {
      file: 'packages/storage/src/history/database/processing-usage.test.ts',
      title: 'refuses a call the daily budget cannot hold and admits one that fits exactly',
    },
  },
  'The response size one processing call may return': {
    demonstratedBy: {
      file: 'apps/orcaops-cli/src/knowledge-worker/loop.test.ts',
      title: 'ends an oversized answer as a terminal failure, not a completion',
    },
  },
  'The transport ceiling on the evidence one review carries': {
    demonstratedBy: {
      file: 'packages/review-engine/src/dossier.test.ts',
      title:
        'oversized eligible diff → refusal envelope naming the ceiling + actual size, no payload minted',
    },
  },
  'The identity an act claims': {
    refuses: () => {
      const claimed = restingOnAssignment(EXCEPTING, {
        kind: 'actor',
        actor: { identity: 'somebody-else', basis: 'other_assertion' },
      });
      // The claim is enforced; the basis, which is only ever an assertion here, is not.
      const asserted = restingOnAssignment(EXCEPTING, ACTING);
      return !claimed.ok && claimed.code === 'ACTOR_NOT_RESPONSIBLE' && asserted.ok;
    },
  },
  'The escalation conditions an assignment records': {
    permits: () => restingOnAssignment(EXCEPTING, ACTING).ok,
  },
  'The tokens and cost a provider reports': {
    demonstratedBy: {
      file: 'packages/storage/src/history/database/processing-usage.test.ts',
      title: 'settles a call with reported usage and keeps a missing cost null',
    },
  },
  'Which agent invoked a command': {
    permits: () => resolveInvokingAgent({ flag: 'codex', env: {} }).agent === 'codex',
  },
};

describe('the enforcement statements the documentation makes', () => {
  it('probes exactly the checks the page names, and no others', () => {
    expect(Object.keys(PROBES).sort()).toEqual(statedChecks().sort());
  });

  it.each(Object.entries(PROBES))('holds the statement about %s', (_check, probe) => {
    if ('refuses' in probe) expect(probe.refuses()).toBe(true);
    else if ('permits' in probe) expect(probe.permits()).toBe(true);
    else expect(read(probe.demonstratedBy.file)).toContain(probe.demonstratedBy.title);
  });
});
