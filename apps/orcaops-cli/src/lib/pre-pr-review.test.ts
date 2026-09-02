import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Repo } from '@orcaops/core';
import type { ResolvedEvaluator } from '@orcaops/evaluator-protocol';
import { makeContext } from '@orcaops/evaluator-sdk';
import { createTempRepo, type TempRepo } from '@orcaops/test-harness';

import { computePrePrReviewFingerprints, requiresRepositoryFingerprint } from './pre-pr-review.js';

describe('pre-PR review fingerprints', () => {
  let fixture: TempRepo;
  let repo: Repo;
  let specPath: string;

  beforeEach(async () => {
    fixture = await createTempRepo();
    repo = new Repo(fixture.path);
    specPath = path.join(fixture.path, 'review.eval.yaml');
    await writeFile(specPath, 'schema: orcaops.evaluator/v1\nid: review\n', 'utf8');
  });

  afterEach(async () => {
    await fixture.cleanup();
  });

  const evaluator = (engine: ResolvedEvaluator['engine']): ResolvedEvaluator => ({
    ref: 'test/review',
    package_id: 'test',
    evaluator_id: 'review',
    package_root: fixture.path,
    spec_path: specPath,
    phase: 'pre-pr',
    severity: 'warn',
    description: 'review fixture',
    engine,
    params: {},
    filters: { paths: [], scopes: [], when_llm: 'optional' },
    resolution: {
      acknowledge: { enabled: false },
      policy_exception: { enabled: false },
    },
    fingerprint_include: [],
    enabled: true,
  });

  const toolFreeLlm = () =>
    evaluator({
      kind: 'llm',
      prompt_file: path.join(fixture.path, 'review.md'),
      output_format: 'markdown',
      timeout_ms: 1000,
      additional_context_sections: [],
    });

  const toolDeclaredLlm = () =>
    evaluator({
      kind: 'llm',
      prompt_file: path.join(fixture.path, 'review.md'),
      output_format: 'markdown',
      timeout_ms: 1000,
      tool_policy: { mode: 'none' },
      additional_context_sections: [],
    });

  const command = () =>
    evaluator({
      kind: 'command',
      command: ['true'],
      cwd: 'repo',
      timeout_ms: 1000,
      max_output_bytes: 1024,
      env: { inherit: [], set: {} },
    });

  const context = () =>
    makeContext({
      phase: 'pre-pr',
      repo: {
        root: fixture.path,
        branch: 'main',
        base_sha: 'base',
        head_sha: 'head',
      },
    });

  it('uses captured context alone only for tool-free LLM evaluators', () => {
    expect(requiresRepositoryFingerprint([toolFreeLlm()])).toBe(false);
    expect(requiresRepositoryFingerprint([toolDeclaredLlm()])).toBe(true);
    expect(requiresRepositoryFingerprint([command()])).toBe(true);
  });

  it('keeps tool-free reviews current across unrelated worktree edits', async () => {
    const before = await computePrePrReviewFingerprints({
      ctx: { repo },
      evaluators: [toolFreeLlm()],
      context: context(),
    });
    await writeFile(path.join(fixture.path, 'README.md'), '# changed\n', 'utf8');
    const after = await computePrePrReviewFingerprints({
      ctx: { repo },
      evaluators: [toolFreeLlm()],
      context: context(),
    });
    expect(after).toEqual(before);
  });

  it('invalidates repository-reading reviews on worktree changes', async () => {
    const before = await computePrePrReviewFingerprints({
      ctx: { repo },
      evaluators: [command()],
      context: context(),
    });
    await writeFile(path.join(fixture.path, 'README.md'), '# changed\n', 'utf8');
    const after = await computePrePrReviewFingerprints({
      ctx: { repo },
      evaluators: [command()],
      context: context(),
    });
    expect(after.evaluator_set_fingerprint).toBe(before.evaluator_set_fingerprint);
    expect(after.review_context_fingerprint).not.toBe(before.review_context_fingerprint);
  });
});
