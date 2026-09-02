import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtureRoot = path.join(packageRoot, 'fixtures');
const checkOnly = process.argv.includes('--check');
const DIGEST_NAMESPACE = 'orcaops:synthetic-confirmation-fixture:v1';
const GENERATOR_PATH = 'scripts/generate-synthetic-confirmation-fixtures.mjs';

function digest(label) {
  return createHash('sha256').update(`${DIGEST_NAMESPACE}:${label}`).digest('hex');
}

function commit(label) {
  return digest(label).slice(0, 40);
}

const semanticAnchorProfile = {
  name: 'semantic-anchor-profile-v1',
  profile_source: 'ENGINE_REGISTERED',
  context_window_tokens: 1_000_000,
  hard_transport_bytes: 2_000_000,
  estimated_token_divisor_bytes: 3,
  instruction_reserve_tokens: 16_000,
  maximum_output_tokens: 32_000,
  context_reserve_percent: 10,
  usable_input_tokens: 852_000,
  maximum_submission_bytes: 128_000,
};

const requiredVersions = {
  story_model: 3,
  prepared_anchor_input: 4,
  semantic_submission: 3,
  semantic_attempt: 3,
  semantic_target: 3,
  semantic_model: 3,
  semantic_manifest: 3,
  semantic_pointer: 3,
};

function implementation(round) {
  const sourceCommit = commit(`${round}:implementation:source`);
  return {
    repository: '/fixtures/synthetic-worktrees/anchor-harness',
    source_commit: sourceCommit,
    build_command: 'pnpm build',
    cli_invocation:
      'node /fixtures/synthetic-worktrees/anchor-harness/apps/example-cli/bin/example.js',
    build_commit_env: sourceCommit,
    build_dirty_env: false,
    package_name: '@fixture/example-cli',
    package_version: '0.0.0-fixture',
    cli_shim_sha256: digest('shared:cli-shim'),
    cli_entry_sha256: digest('shared:cli-entry'),
    compiled_runtime_manifest_sha256: digest(`${round}:compiled-runtime-manifest`),
    runtime_fingerprint_sha256: digest(`${round}:runtime-fingerprint`),
    lockfile_sha256: digest('shared:lockfile'),
    node_version: 'synthetic-node-runtime',
    pnpm_version: 'synthetic-package-manager',
  };
}

function reviewer() {
  const instructionHash = digest('shared:task-review-skill');
  return {
    task_review_skill:
      '/fixtures/synthetic-worktrees/anchor-harness/.agents/skills/orcaops-task-review/SKILL.md',
    task_review_skill_sha256: instructionHash,
    execution_profile: {
      host: {
        value: 'synthetic-agent-host',
        provenance: 'EVALUATION_REGISTERED',
      },
      host_version: null,
      model: {
        value: 'synthetic-review-model',
        provenance: 'EVALUATION_REGISTERED',
      },
      effort: {
        value: 'fixture',
        provenance: 'EVALUATION_REGISTERED',
      },
      launcher_mode: {
        value: 'synthetic-sequential-runner',
        provenance: 'EVALUATION_REGISTERED',
      },
      instruction_hash: {
        value: instructionHash,
        provenance: 'EVALUATION_REGISTERED',
      },
    },
  };
}

function stableSubjects() {
  return [
    {
      id: 'SYNTHETIC_LIBRARY_PATCH',
      repository: '/fixtures/synthetic-repositories/library-patch',
      branch: 'fixture/library-update-hook',
      head: commit('subject:library:head'),
      base: commit('subject:library:base'),
      committed_diff_sha256: digest('subject:library:committed-diff'),
      committed_diff_bytes: 26_046,
      tracked_worktree_diff_sha256: digest('subject:library:worktree-diff'),
      tracked_worktree_diff_bytes: 548,
      status_sha256: digest('subject:library:status'),
      untracked_inventory_sha256: digest('subject:library:untracked-inventory'),
      config_sha256: digest('subject:library:config'),
    },
    {
      id: 'SYNTHETIC_STUB_HEAVY_REPOSITORY',
      repository: '/fixtures/synthetic-worktrees/stub-heavy',
      branch: 'fixture/stub-heavy',
      head: commit('subject:stub-heavy:head'),
      base: commit('subject:stub-heavy:base'),
      committed_diff_sha256: digest('subject:stub-heavy:committed-diff'),
      committed_diff_bytes: 23_786_305,
      tracked_worktree_diff_sha256: digest('subject:stub-heavy:worktree-diff'),
      tracked_worktree_diff_bytes: 48_134,
      status_sha256: digest('subject:stub-heavy:status'),
      untracked_inventory_sha256: digest('subject:stub-heavy:untracked-inventory'),
      config_sha256: digest('subject:shared-review-config'),
    },
  ];
}

function activeSubject(round) {
  const reviewedCommit = commit(`subject:active:${round}:reviewed-commit`);
  if (round === 'initial') {
    return {
      id: 'SYNTHETIC_ACTIVE_CHANGESET',
      repository: '/fixtures/synthetic-worktrees/active-changeset',
      branch: 'fixture/active-changeset',
      reviewed_implementation_commit: reviewedCommit,
      base: commit('subject:active:base'),
      committed_diff_sha256: digest('subject:active:initial:committed-diff'),
      committed_diff_bytes: 24_671_117,
      tracked_worktree_diff_sha256: digest('subject:active:worktree-diff'),
      tracked_worktree_diff_bytes: 735,
      status_sha256_after_fixture_commit: digest('subject:active:status'),
      untracked_inventory_sha256_after_fixture_commit: digest('subject:active:untracked-inventory'),
      config_sha256: digest('subject:shared-review-config'),
      harness_path_policy_stub: 'packages/review-engine/fixtures/**',
      note: 'The fixture directory is policy-stubbed harness evidence. Recheck the synthetic implementation diff and require the eligible target-space hash to remain stable.',
    };
  }
  return {
    id: 'SYNTHETIC_ACTIVE_CHANGESET',
    repository: '/fixtures/synthetic-worktrees/active-changeset',
    branch: 'fixture/active-changeset',
    reviewed_implementation_commit: reviewedCommit,
    base: commit('subject:active:base'),
    committed_implementation_diff_sha256: digest('subject:active:corrected:committed-diff'),
    committed_implementation_diff_bytes: 24_717_986,
    tracked_worktree_diff_sha256: digest('subject:active:worktree-diff'),
    tracked_worktree_diff_bytes: 735,
    status_without_harness_sha256: digest('subject:active:status'),
    untracked_inventory_without_harness_sha256: digest('subject:active:untracked-inventory'),
    config_sha256: digest('subject:shared-review-config'),
    harness_path_policy_stub: 'packages/review-engine/fixtures/**',
    note: 'The fixture directory is policy-stubbed harness evidence. Recheck the synthetic implementation diff and filtered status hashes before and after the run.',
  };
}

async function freeze(round) {
  const corrected = round === 'corrected';
  const fixtureName = corrected
    ? 'truth-anchor-confirmation-corrected'
    : 'truth-anchor-confirmation';
  const protocolPath = path.join(fixtureRoot, fixtureName, 'PROTOCOL.md');
  const result = {
    schema_version: 1,
    fixture_provenance: {
      kind: 'DETERMINISTIC_SYNTHETIC',
      generator: GENERATOR_PATH,
      seed: `${fixtureName}-v1`,
      digest_namespace: DIGEST_NAMESPACE,
    },
    frozen_at: corrected ? '2000-01-01T01:00:00.000Z' : '2000-01-01T00:00:00.000Z',
    protocol: 'PROTOCOL.md',
    protocol_sha256: createHash('sha256')
      .update(await readFile(protocolPath))
      .digest('hex'),
    no_tuning_after_freeze: true,
  };

  if (corrected) {
    result.supersedes_failed_round = false;
    result.prior_round = '../truth-anchor-confirmation';
  }

  result.implementation = implementation(round);
  result.reviewer = reviewer();
  result.semantic_anchor_profile = semanticAnchorProfile;
  result.subjects = [...stableSubjects(), activeSubject(round)];
  result.required_versions = requiredVersions;
  result.stop_conditions = [
    'subject_identity_drift',
    'runtime_fingerprint_drift',
    ...(corrected ? ['compiled_runtime_manifest_drift'] : []),
    'unhealthy_floor',
    'unexpected_size_refusal',
    'terminal_lane_rejection',
    'corrupt_current_generation',
    'post_freeze_tuning',
  ];
  return { fixtureName, result };
}

let mismatch = false;
for (const round of ['initial', 'corrected']) {
  const { fixtureName, result } = await freeze(round);
  const outputPath = path.join(fixtureRoot, fixtureName, 'FREEZE.json');
  const expected = `${JSON.stringify(result, null, 2)}\n`;
  if (checkOnly) {
    const actual = await readFile(outputPath, 'utf8');
    if (actual !== expected) {
      mismatch = true;
      process.stderr.write(`${outputPath} is not generated from the synthetic fixture template\n`);
    }
  } else {
    await writeFile(outputPath, expected);
  }
}

if (mismatch) process.exitCode = 1;
