import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  SEMANTIC_ANCHOR_ATTEMPT_SCHEMA_VERSION,
  SEMANTIC_ANCHOR_MANIFEST_SCHEMA_VERSION,
  SEMANTIC_ANCHOR_MODEL_SCHEMA_VERSION,
  SEMANTIC_ANCHOR_POINTER_SCHEMA_VERSION,
  SEMANTIC_ANCHOR_SUBMISSION_SCHEMA_VERSION,
  SEMANTIC_ANCHOR_TARGET_SCHEMA_VERSION,
} from './semanticAnchorGenerations.js';
import {
  SEMANTIC_ANCHOR_INPUT_SCHEMA_VERSION,
  SEMANTIC_ANCHOR_PROFILE_V1,
} from './semanticAnchors.js';
import { STORY_REVIEW_MODEL_SCHEMA_VERSION } from './storyReviewModel.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const fixtureDirs = ['truth-anchor-confirmation', 'truth-anchor-confirmation-corrected'].map(
  (fixture) => path.join(repoRoot, 'packages/review-engine/fixtures', fixture)
);
const sha256 = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
const SYNTHETIC_DIGEST_NAMESPACE = 'orcaops:synthetic-confirmation-fixture:v1';
const syntheticDigest = (label: string): string => sha256(`${SYNTHETIC_DIGEST_NAMESPACE}:${label}`);

interface FrozenConfirmation {
  fixture_provenance: {
    kind: string;
    generator: string;
    seed: string;
    digest_namespace: string;
  };
  protocol: string;
  protocol_sha256: string;
  no_tuning_after_freeze: boolean;
  implementation: {
    repository: string;
    cli_invocation: string;
  };
  reviewer: {
    task_review_skill: string;
    task_review_skill_sha256: string;
    execution_profile: {
      host: { value: string };
      model: { value: string };
      instruction_hash: { value: string };
    };
  };
  semantic_anchor_profile: Record<string, unknown>;
  subjects: Array<{ id: string; repository: string; branch: string }>;
  required_versions: Record<string, number>;
  stop_conditions: string[];
}

describe('frozen three-subject confirmation contract', () => {
  it('binds the protocol and all identities to the deterministic synthetic template', async () => {
    const canonicalSkillPath = '.agents/skills/orcaops-task-review/SKILL.md';
    for (const fixtureDir of fixtureDirs) {
      const freeze = JSON.parse(
        await readFile(path.join(fixtureDir, 'FREEZE.json'), 'utf8')
      ) as FrozenConfirmation;
      const fixtureName = path.basename(fixtureDir);
      expect(freeze.fixture_provenance).toEqual({
        kind: 'DETERMINISTIC_SYNTHETIC',
        generator: 'scripts/generate-synthetic-confirmation-fixtures.mjs',
        seed: `${fixtureName}-v1`,
        digest_namespace: SYNTHETIC_DIGEST_NAMESPACE,
      });
      expect(sha256(await readFile(path.join(fixtureDir, freeze.protocol)))).toBe(
        freeze.protocol_sha256
      );
      expect(freeze.implementation.repository).toBe('/fixtures/synthetic-worktrees/anchor-harness');
      expect(freeze.implementation.cli_invocation).toContain(
        '/fixtures/synthetic-worktrees/anchor-harness/'
      );
      expect(freeze.reviewer.task_review_skill.endsWith(canonicalSkillPath)).toBe(true);
      expect(freeze.reviewer.task_review_skill_sha256).toBe(
        syntheticDigest('shared:task-review-skill')
      );
      expect(freeze.reviewer.execution_profile.instruction_hash.value).toBe(
        syntheticDigest('shared:task-review-skill')
      );
      expect(freeze.reviewer.execution_profile.host.value).toBe('synthetic-agent-host');
      expect(freeze.reviewer.execution_profile.model.value).toBe('synthetic-review-model');
      expect(JSON.stringify(freeze)).not.toMatch(/\/home\/|demo-/i);
      expect(freeze.no_tuning_after_freeze).toBe(true);
      expect(freeze.stop_conditions).toEqual(
        expect.arrayContaining([
          'subject_identity_drift',
          'runtime_fingerprint_drift',
          'post_freeze_tuning',
        ])
      );
    }
  });

  it('pins its historical contract versions and the registered anchor profile', async () => {
    expect(STORY_REVIEW_MODEL_SCHEMA_VERSION).toBe(4);
    for (const fixtureDir of fixtureDirs) {
      const freeze = JSON.parse(
        await readFile(path.join(fixtureDir, 'FREEZE.json'), 'utf8')
      ) as FrozenConfirmation;
      expect(freeze.required_versions).toEqual({
        // Immutable historical evidence: these confirmation subjects were
        // finalized against Story v3 and are never reinterpreted as v4.
        story_model: 3,
        prepared_anchor_input: SEMANTIC_ANCHOR_INPUT_SCHEMA_VERSION,
        semantic_submission: SEMANTIC_ANCHOR_SUBMISSION_SCHEMA_VERSION,
        semantic_attempt: SEMANTIC_ANCHOR_ATTEMPT_SCHEMA_VERSION,
        semantic_target: SEMANTIC_ANCHOR_TARGET_SCHEMA_VERSION,
        semantic_model: SEMANTIC_ANCHOR_MODEL_SCHEMA_VERSION,
        semantic_manifest: SEMANTIC_ANCHOR_MANIFEST_SCHEMA_VERSION,
        semantic_pointer: SEMANTIC_ANCHOR_POINTER_SCHEMA_VERSION,
      });
      expect(freeze.semantic_anchor_profile).toEqual({
        name: SEMANTIC_ANCHOR_PROFILE_V1.profile,
        profile_source: SEMANTIC_ANCHOR_PROFILE_V1.profile_source,
        context_window_tokens: SEMANTIC_ANCHOR_PROFILE_V1.context_window_tokens,
        hard_transport_bytes: SEMANTIC_ANCHOR_PROFILE_V1.hard_transport_bytes,
        estimated_token_divisor_bytes: SEMANTIC_ANCHOR_PROFILE_V1.estimated_token_divisor_bytes,
        instruction_reserve_tokens: SEMANTIC_ANCHOR_PROFILE_V1.instruction_reserve_tokens,
        maximum_output_tokens: SEMANTIC_ANCHOR_PROFILE_V1.maximum_output_tokens,
        context_reserve_percent: SEMANTIC_ANCHOR_PROFILE_V1.context_reserve_percent,
        usable_input_tokens: 852_000,
        maximum_submission_bytes: SEMANTIC_ANCHOR_PROFILE_V1.maximum_submission_bytes,
      });
    }
  });

  it('freezes all three distinct subjects and keeps harness evidence policy-stubbed', async () => {
    for (const fixtureDir of fixtureDirs) {
      const freeze = JSON.parse(
        await readFile(path.join(fixtureDir, 'FREEZE.json'), 'utf8')
      ) as FrozenConfirmation;
      expect(freeze.subjects.map((subject) => subject.id)).toEqual([
        'SYNTHETIC_LIBRARY_PATCH',
        'SYNTHETIC_STUB_HEAVY_REPOSITORY',
        'SYNTHETIC_ACTIVE_CHANGESET',
      ]);
      for (const subject of freeze.subjects) {
        expect(subject.repository).toMatch(/^\/fixtures\/synthetic-/);
        expect(subject.branch).toMatch(/^fixture\//);
      }
    }
    const config = JSON.parse(
      await readFile(path.join(repoRoot, '.orcaops/config.json'), 'utf8')
    ) as { review?: { stub_paths?: string[] } };
    expect(config.review?.stub_paths).toContain('packages/review-engine/fixtures/**');
  });
});
