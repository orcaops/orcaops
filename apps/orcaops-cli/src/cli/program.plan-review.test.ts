import type { Command } from 'commander';
import { describe, expect, it } from 'vitest';

import { DEFAULT_CLOUD_BASE_URL } from '@orcaops/core';

import { buildProgram } from './program.js';

const buildOfficialProgram = () => buildProgram({ cloudBaseUrl: DEFAULT_CLOUD_BASE_URL });

function sub(cmd: Command, name: string): Command | undefined {
  return cmd.commands.find((c) => c.name() === name);
}

/** The TOP-LEVEL cloud `plan` group (the one carrying upload/pull), not capture's. */
function cloudPlanGroup(): Command {
  const program = buildOfficialProgram();
  const group = program.commands.find((c) => c.name() === 'plan' && !!sub(c, 'upload'));
  if (!group) throw new Error('cloud plan group not found');
  return group;
}

describe('plan review command registration', () => {
  it('registers the full review roster under the cloud plan group', () => {
    const review = sub(cloudPlanGroup(), 'review');
    expect(review).toBeDefined();
    const names = review!.commands.map((c) => c.name()).sort();
    expect(names).toEqual([
      'approve',
      'comment',
      'decline',
      'diff',
      'list',
      'propose',
      'pull',
      'push',
      'reviewers',
      'status',
      'verdict',
      'view',
    ]);
  });

  it('pull --version conflicts with --proposal (a sealed version has no proposal side)', () => {
    const pull = sub(sub(cloudPlanGroup(), 'review')!, 'pull')!;
    const version = pull.options.find((o) => o.long === '--version');
    expect(version).toBeDefined();
    expect((version as unknown as { conflictsWith: string[] }).conflictsWith).toContain('proposal');
  });

  it('diff --from conflicts with --proposal; --to is registered', () => {
    const diff = sub(sub(cloudPlanGroup(), 'review')!, 'diff')!;
    const from = diff.options.find((o) => o.long === '--from');
    expect(from).toBeDefined();
    expect((from as unknown as { conflictsWith: string[] }).conflictsWith).toContain('proposal');
    expect(diff.options.find((o) => o.long === '--to')).toBeDefined();
  });

  it('verdict --approve conflicts with --request-changes (parser-level both-set guard)', () => {
    const verdict = sub(sub(cloudPlanGroup(), 'review')!, 'verdict')!;
    const approve = verdict.options.find((o) => o.long === '--approve');
    expect(approve).toBeDefined();
    expect((approve as unknown as { conflictsWith: string[] }).conflictsWith).toContain(
      'requestChanges'
    );
  });

  it('approve --no-open registers as a negated boolean (open defaults true)', () => {
    const approve = sub(sub(cloudPlanGroup(), 'review')!, 'approve')!;
    const noOpen = approve.options.find((o) => o.long === '--no-open');
    expect(noOpen).toBeDefined();
  });

  it('push --on-conflict is a fail|propose choice defaulting to fail', () => {
    const push = sub(sub(cloudPlanGroup(), 'review')!, 'push')!;
    const onConflict = push.options.find((o) => o.long === '--on-conflict');
    expect(onConflict).toBeDefined();
    expect(onConflict!.argChoices).toEqual(['fail', 'propose']);
    expect(onConflict!.defaultValue).toBe('fail');
  });

  it('review lives on the cloud plan group, not on capture plan', () => {
    const program = buildOfficialProgram();
    const capture = program.commands.find((c) => c.name() === 'capture');
    const capturePlan = capture ? sub(capture, 'plan') : undefined;
    expect(capturePlan && sub(capturePlan, 'review')).toBeFalsy();
  });
});
