import { createHash } from 'node:crypto';

import {
  displaySubject,
  type SeedCheckpointGroup,
  type SeedCluster,
  wordBoundaryPrefix,
} from '@orcaops/core';
import type { ArtifactOriginJob, PlanInput, SummaryInput } from '@orcaops/storage';
import {
  ARTIFACT_LABEL_MAX,
  canonicalMemberShas,
  computeMemberShasHash,
  uuidv7,
} from '@orcaops/storage';

export interface SeedCheckpointSynthesis {
  n: number;
  stepId: string;
  timestamp: string;
  group: SeedCheckpointGroup;
  summary: string;
  idempotencyKeys: { open: string; close: string };
}

export interface SeedClusterSynthesis {
  artifactId: string;
  cluster: SeedCluster;
  plan: PlanInput;
  checkpoints: SeedCheckpointSynthesis[];
  summary: SummaryInput;
  idempotencyKeys: { plan: string; summary: string };
}

export interface SynthesizeSeedClusterOptions {
  cluster: SeedCluster;
  branch: string;
  rootSha: string;
  installNonce: string;
  importedAt: string;
  toolVersion: string;
  /**
   * The apply run this artifact belongs to. Absent on dry runs (nothing is
   * written) and on any caller that predates the ledger; the origin key is
   * spread conditionally so a job-less import hashes exactly as before.
   */
  job?: ArtifactOriginJob;
}

function deterministicBytes(input: string): Buffer {
  return createHash('sha256').update(input, 'utf8').digest();
}

function deterministicId(nowIso: string, seed: string): string {
  const now = Date.parse(nowIso);
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new RangeError(`Seed timestamp is outside the UUIDv7 range: ${nowIso}`);
  }
  return uuidv7({ now, random: () => deterministicBytes(seed) });
}

function protocolTimestamp(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new RangeError(`Invalid seed timestamp: ${value}`);
  }
  return date.toISOString();
}

function seedKey(opts: SynthesizeSeedClusterOptions, suffix: string): string {
  return `orcaops-seed:v1:${opts.installNonce}:${opts.rootSha}:${opts.cluster.key}:${suffix}`;
}

function reconciliationClusterKey(opts: SynthesizeSeedClusterOptions): string {
  return deterministicBytes(`orcaops-seed:v1:${opts.rootSha}:${opts.cluster.key}`).toString('hex');
}

function oneLine(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}

/**
 * A truncation that keeps an ODD number of double quotes has cut a quoted
 * span open (`Landed "fix the …`) — drop the dangling opener and what
 * follows it so every kept quote pair stays balanced.
 */
function balanceQuotes(kept: string): string {
  const quotes = kept.split('"').length - 1;
  if (quotes % 2 === 0) return kept;
  const lastQuote = kept.lastIndexOf('"');
  return lastQuote > 0 ? kept.slice(0, lastQuote).trimEnd() : kept;
}

function truncate(value: string, max = ARTIFACT_LABEL_MAX): string {
  const normalized = oneLine(value);
  if (normalized.length <= max) return normalized;
  return `${balanceQuotes(wordBoundaryPrefix(normalized, max))}…`;
}

function touchedScope(files: readonly string[]): string[] {
  const unique = [...new Set(files)].sort();
  if (unique.length <= 400) return unique;
  return [...new Set(unique.map((file) => file.split('/')[0] || file))].sort();
}

function uniqueStepLabels(cluster: SeedCluster): string[] {
  const seen = new Set<string>();
  return cluster.checkpoints.map((group) => {
    const member = group.commits.at(-1)!;
    let label = truncate(displaySubject(member.subject));
    if (seen.has(label)) {
      const suffix = ` [${member.sha.slice(0, 7)}]`;
      label = `${balanceQuotes(label.slice(0, ARTIFACT_LABEL_MAX - suffix.length).trimEnd())}${suffix}`;
    }
    seen.add(label);
    return label;
  });
}

function taskText(cluster: SeedCluster): string {
  const commits = cluster.commits.map((commit) => {
    const body = commit.body.trim();
    return `- ${commit.sha.slice(0, 7)} ${oneLine(commit.subject)}${body ? `\n  ${body}` : ''}`;
  });
  return [`Imported from git history: ${cluster.label}`, '', ...commits].join('\n');
}

export function synthesizeSeedCluster(opts: SynthesizeSeedClusterOptions): SeedClusterSynthesis {
  const { cluster } = opts;
  const artifactId = deterministicId(cluster.displayDateIso, seedKey(opts, 'artifact'));
  const labels = uniqueStepLabels(cluster);
  const checkpoints = cluster.checkpoints.map((group, index): SeedCheckpointSynthesis => {
    const stepId = deterministicId(group.committerDateIso, seedKey(opts, `step:${group.key}`));
    return {
      n: index + 1,
      stepId,
      timestamp: protocolTimestamp(group.committerDateIso),
      group,
      summary:
        group.commits.length === 1
          ? `Landed ${oneLine(group.commits[0]!.subject)}`
          : `Landed ${group.commits.length} commits from ${group.key}`,
      idempotencyKeys: {
        open: seedKey(opts, `checkpoint:${group.key}:open`),
        close: seedKey(opts, `checkpoint:${group.key}:close`),
      },
    };
  });
  const plan: PlanInput = {
    schema_version: 4,
    artifact_id: artifactId,
    branch: opts.branch,
    base_sha: cluster.baseSha,
    agent: 'other',
    agent_session_id: null,
    task: taskText(cluster),
    label: truncate(cluster.label),
    plan_steps: checkpoints.map((checkpoint, index) => ({
      step_id: checkpoint.stepId,
      text: checkpoint.summary,
      label: labels[index]!,
      acceptance_criteria: [],
    })),
    touched_scope: touchedScope(cluster.files),
    non_goals: [],
    decisions: [],
    origin: {
      kind: 'git-import',
      imported_at: opts.importedAt,
      tool_version: opts.toolVersion,
      source_range: `${cluster.baseSha}..${cluster.headSha}`,
      authors: cluster.authors,
      enriched_at: null,
      cluster_key: reconciliationClusterKey(opts),
      member_shas: canonicalMemberShas(cluster.commits.map((commit) => commit.sha)),
      member_shas_hash: computeMemberShasHash(cluster.commits.map((commit) => commit.sha)),
      ...(opts.job ? { job: opts.job } : {}),
    },
    started_at: protocolTimestamp(cluster.commits[0]!.committerDateIso),
    revision_n: 0,
    revised_at: null,
    rationale: null,
    step_lineage: { added: [], dropped: [], unchanged: [], rewritten: [] },
    criterion_lineage: { added: [], carried: [], removed: [], rewritten: [] },
    prior_plan_event_id: null,
  };
  const summary: SummaryInput = {
    schema_version: 1,
    artifact_id: artifactId,
    agent: 'other',
    outcome: `Landed ${cluster.label}: ${cluster.commits.length} commit${cluster.commits.length === 1 ? '' : 's'} touching ${cluster.files.length} file${cluster.files.length === 1 ? '' : 's'}`,
    tests_written: [],
    tests_run: [],
    open_items: [],
    deferred_decisions: [],
    head_sha: cluster.headSha,
    ts: protocolTimestamp(cluster.displayDateIso),
  };
  return {
    artifactId,
    cluster,
    plan,
    checkpoints,
    summary,
    idempotencyKeys: {
      plan: seedKey(opts, 'plan'),
      summary: seedKey(opts, 'summary'),
    },
  };
}
