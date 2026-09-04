import type {
  DigestAcknowledgedBlock,
  DigestData,
  DigestDecision,
  DigestEvaluatorRow,
  DigestUsage,
} from './builder.js';

export interface BranchArtifactAnchor {
  source: 'checkpoint' | 'summary' | 'pre_pr';
  n?: number;
  head_sha: string;
}

export interface BranchArtifactInput {
  data: DigestData;
  state: string;
  order: number;
  anchors: BranchArtifactAnchor[];
  matched_anchors: BranchArtifactAnchor[];
}

export interface BranchDigestRangeData {
  branch: string;
  base: string;
  base_sha: string;
  merge_base: string;
  head_sha: string;
  commit_count: number;
}

export interface BranchSource {
  artifact_id: string;
  checkpoint?: number;
  revision_n?: number;
  evaluator_ref?: string;
}

export interface BranchDigestData {
  mode: 'branch-wide';
  branch: string;
  base: string;
  range: {
    base_sha: string;
    merge_base: string;
    head: string;
    commit_count: number;
  };
  title: {
    text: string;
    source_artifact_id: string;
    selection_rule: 'earliest_summarized_artifact' | 'explicit_primary_artifact';
  } | null;
  title_candidates: Array<{ text: string; artifact_id: string; order: number }>;
  artifacts: Array<{
    id: string;
    label: string;
    role: 'primary' | 'follow-up' | 'unclassified';
    state: string;
    order: number;
    is_complete: boolean;
    origin: DigestData['origin'];
    plan_base_sha: string;
    anchors: BranchArtifactAnchor[];
    matched_anchors: BranchArtifactAnchor[];
    relationship: 'in_range';
  }>;
  outcome: string | null;
  outcomes: Array<{ text: string; source: BranchSource }>;
  changes: Array<{
    summary: string;
    files_changed: string[];
    source: BranchSource;
  }>;
  decisions: Array<DigestDecision & { sources: BranchSource[] }>;
  open_items: Array<{
    text: string;
    kind: 'open_item' | 'deferred_decision' | 'uncertainty' | 'uncovered_step';
    sources: BranchSource[];
  }>;
  tests: Array<{
    text: string;
    kind: 'verification' | 'test_run' | 'test_written';
    exit_code?: number;
    output_digest?: string;
    note?: string;
    sources: BranchSource[];
  }>;
  release_checks: Array<DigestEvaluatorRow & { sources: BranchSource[] }>;
  warnings: Array<DigestEvaluatorRow & { source: BranchSource }>;
  policy_exceptions: Array<{
    evaluator_ref: string;
    reason: string;
    source: BranchSource;
  }>;
  acknowledged_blocks: Array<DigestAcknowledgedBlock & { source: BranchSource }>;
  usage: Omit<DigestUsage, 'attributed_estimate'>;
  incomplete_artifact_ids: string[];
  excluded_artifacts: Array<{
    id: string;
    reason: 'reachable_out_of_range' | 'unreachable_from_head' | 'unverifiable';
  }>;
  unreadable_artifacts: Array<{
    id: string;
    reason: 'unverifiable';
  }>;
}

export class BranchDigestInputError extends Error {}

function normalized(value: string): string {
  return value.trim().replace(/\s+/gu, ' ').toLocaleLowerCase('en-US');
}

function decisionIdentity(decision: DigestDecision): string {
  return JSON.stringify([
    normalized(decision.decision),
    normalized(decision.reason),
    (decision.alternatives_considered ?? []).map((alternative) => [
      normalized(alternative.option),
      normalized(alternative.rejected_because),
    ]),
    decision.evidence
      ? [decision.evidence.kind, decision.evidence.commit_sha, normalized(decision.evidence.quote)]
      : null,
  ]);
}

function mergeSources(...groups: readonly BranchSource[][]): BranchSource[] {
  const merged = new Map<string, BranchSource>();
  for (const source of groups.flat()) {
    const key = `${source.artifact_id}\0${source.checkpoint ?? ''}\0${source.revision_n ?? ''}\0${source.evaluator_ref ?? ''}`;
    if (!merged.has(key)) merged.set(key, source);
  }
  return [...merged.values()];
}

function mergeOpenItem(
  target: BranchDigestData['open_items'],
  item: BranchDigestData['open_items'][number]
): void {
  const existing = target.find(
    (candidate) =>
      candidate.kind === item.kind && normalized(candidate.text) === normalized(item.text)
  );
  if (existing) existing.sources.push(...item.sources);
  else target.push(item);
}

function mergeUsage(artifacts: readonly BranchArtifactInput[]): BranchDigestData['usage'] {
  const bySession = new Map<string, DigestUsage['sessions'][number]>();
  for (const artifact of artifacts) {
    for (const session of artifact.data.usage?.sessions ?? []) {
      const key = `${session.agent}\0${session.session_id}`;
      const prior = bySession.get(key);
      if (!prior) {
        bySession.set(key, { ...session });
        continue;
      }
      bySession.set(key, {
        ...(session.record_count >= prior.record_count ? session : prior),
        input_tokens: Math.max(prior.input_tokens, session.input_tokens),
        output_tokens: Math.max(prior.output_tokens, session.output_tokens),
        cache_creation_input_tokens: Math.max(
          prior.cache_creation_input_tokens,
          session.cache_creation_input_tokens
        ),
        cache_read_input_tokens: Math.max(
          prior.cache_read_input_tokens,
          session.cache_read_input_tokens
        ),
        record_count: Math.max(prior.record_count, session.record_count),
      });
    }
  }
  const sessions = [...bySession.values()].sort((a, b) =>
    a.agent === b.agent ? a.session_id.localeCompare(b.session_id) : a.agent.localeCompare(b.agent)
  );
  return { has_usage: sessions.length > 0, sessions };
}

export function buildBranchDigestData(input: {
  range: BranchDigestRangeData;
  artifacts: readonly BranchArtifactInput[];
  primaryArtifactId?: string;
  excludedArtifacts?: BranchDigestData['excluded_artifacts'];
  unreadableArtifacts?: BranchDigestData['unreadable_artifacts'];
}): BranchDigestData {
  const artifacts = [...input.artifacts].sort((a, b) =>
    a.order !== b.order
      ? a.order - b.order
      : a.data.started_at !== b.data.started_at
        ? a.data.started_at.localeCompare(b.data.started_at)
        : a.data.artifact_id.localeCompare(b.data.artifact_id)
  );
  const candidates = artifacts
    .filter((artifact) => artifact.data.is_complete && artifact.data.outcome !== null)
    .map((artifact) => ({
      text: artifact.data.label,
      artifact_id: artifact.data.artifact_id,
      order: artifact.order,
    }));
  const selected =
    input.primaryArtifactId === undefined
      ? candidates[0]
      : candidates.find((candidate) => candidate.artifact_id === input.primaryArtifactId);
  if (input.primaryArtifactId !== undefined && selected === undefined) {
    throw new BranchDigestInputError(
      `--primary-artifact must name an included artifact with a captured summary; got "${input.primaryArtifactId}".`
    );
  }
  const primaryId = selected?.artifact_id;
  const outcomes: BranchDigestData['outcomes'] = [];
  const changes: BranchDigestData['changes'] = [];
  const decisionByKey = new Map<string, BranchDigestData['decisions'][number]>();
  const openItems: BranchDigestData['open_items'] = [];
  const tests: BranchDigestData['tests'] = [];
  const successfulVerification = new Map<string, BranchDigestData['tests'][number]>();
  const verificationByKey = new Map<string, BranchDigestData['tests'][number][]>();
  const releaseChecks: BranchDigestData['release_checks'] = [];
  const passingReleaseCheck = new Map<string, BranchDigestData['release_checks'][number]>();
  const warnings: BranchDigestData['warnings'] = [];
  const policyExceptions: BranchDigestData['policy_exceptions'] = [];
  const acknowledgedBlocks: BranchDigestData['acknowledged_blocks'] = [];

  for (const artifact of artifacts) {
    const artifactId = artifact.data.artifact_id;
    if (artifact.data.outcome !== null) {
      outcomes.push({ text: artifact.data.outcome, source: { artifact_id: artifactId } });
    }
    for (const checkpoint of artifact.data.checkpoints) {
      const source = { artifact_id: artifactId, checkpoint: checkpoint.n };
      changes.push({
        summary: checkpoint.summary,
        files_changed: checkpoint.files_changed,
        source,
      });
      for (const verification of checkpoint.verification ?? []) {
        const test = {
          text: verification.command,
          kind: 'verification' as const,
          exit_code: verification.exit_code,
          ...(verification.output_digest !== undefined
            ? { output_digest: verification.output_digest }
            : {}),
          ...(verification.note !== undefined ? { note: verification.note } : {}),
          sources: [source],
        };
        const key = normalized(verification.command);
        const evidence = verificationByKey.get(key);
        if (evidence) evidence.push(test);
        else verificationByKey.set(key, [test]);
        if (verification.exit_code === 0) {
          const prior = successfulVerification.get(key);
          successfulVerification.set(key, {
            ...test,
            sources: mergeSources(prior?.sources ?? [], test.sources),
          });
        } else tests.push(test);
      }
    }
    for (const decision of artifact.data.decisions) {
      const source: BranchSource = {
        artifact_id: artifactId,
        ...(decision.checkpoint !== undefined ? { checkpoint: decision.checkpoint } : {}),
        ...(decision.revision_n !== undefined ? { revision_n: decision.revision_n } : {}),
      };
      const key = decisionIdentity(decision);
      const prior = decisionByKey.get(key);
      decisionByKey.set(key, {
        ...decision,
        sources: mergeSources(prior?.sources ?? [], [source]),
      });
    }
    for (const text of artifact.data.open_items) {
      mergeOpenItem(openItems, {
        text,
        kind: 'open_item',
        sources: [{ artifact_id: artifactId }],
      });
    }
    for (const text of artifact.data.deferred_decisions) {
      mergeOpenItem(openItems, {
        text,
        kind: 'deferred_decision',
        sources: [{ artifact_id: artifactId }],
      });
    }
    for (const uncertainty of artifact.data.open_uncertainty) {
      mergeOpenItem(openItems, {
        text: uncertainty.item,
        kind: 'uncertainty',
        sources: [{ artifact_id: artifactId, checkpoint: uncertainty.checkpoint }],
      });
    }
    for (const step of artifact.data.uncompleted_steps) {
      mergeOpenItem(openItems, {
        text: step.label,
        kind: 'uncovered_step',
        sources: [{ artifact_id: artifactId }],
      });
    }
    for (const text of artifact.data.tests_run) {
      const existing = tests.find(
        (test) => test.kind === 'test_run' && normalized(test.text) === normalized(text)
      );
      if (existing) existing.sources.push({ artifact_id: artifactId });
      else
        tests.push({
          text,
          kind: 'test_run',
          sources: [{ artifact_id: artifactId }],
        });
    }
    for (const text of artifact.data.tests_written) {
      const existing = tests.find(
        (test) => test.kind === 'test_written' && normalized(test.text) === normalized(text)
      );
      if (existing) existing.sources.push({ artifact_id: artifactId });
      else
        tests.push({
          text,
          kind: 'test_written',
          sources: [{ artifact_id: artifactId }],
        });
    }
    for (const row of artifact.data.release_checks) {
      const withSources = {
        ...row,
        sources: [{ artifact_id: artifactId, evaluator_ref: row.evaluator_ref }],
      };
      if (row.status === 'pass') {
        const key = `${row.evaluator_ref}\0${row.phase}`;
        const prior = passingReleaseCheck.get(key);
        passingReleaseCheck.set(key, {
          ...withSources,
          sources: mergeSources(prior?.sources ?? [], withSources.sources),
        });
      } else releaseChecks.push(withSources);
    }
    for (const row of artifact.data.process_notes) {
      if (row.status !== 'pass' && row.status !== 'info') {
        warnings.push({
          ...row,
          source: { artifact_id: artifactId, evaluator_ref: row.evaluator_ref },
        });
      }
    }
    for (const exception of artifact.data.policy_exceptions) {
      policyExceptions.push({
        evaluator_ref: exception.evaluator_ref,
        reason: exception.reason,
        source: { artifact_id: artifactId, checkpoint: exception.cp_n },
      });
    }
    for (const block of artifact.data.acknowledged_blocks) {
      acknowledgedBlocks.push({ ...block, source: { artifact_id: artifactId } });
    }
  }
  for (const [key, verification] of verificationByKey) {
    const matchingRuns = tests.filter(
      (test) => test.kind === 'test_run' && normalized(test.text) === key
    );
    for (const run of matchingRuns) tests.splice(tests.indexOf(run), 1);
    const target = successfulVerification.get(key) ?? verification.at(-1);
    if (target) {
      target.sources = mergeSources(
        target.sources,
        matchingRuns.flatMap((run) => run.sources)
      );
    }
  }
  tests.push(...successfulVerification.values());
  releaseChecks.push(...passingReleaseCheck.values());
  releaseChecks.sort((a, b) =>
    a.ts !== b.ts ? a.ts.localeCompare(b.ts) : a.evaluator_ref.localeCompare(b.evaluator_ref)
  );
  const primaryOutcome = outcomes.find((item) => item.source.artifact_id === selected?.artifact_id);
  const followUpOutcomes = outcomes.filter((item) => item !== primaryOutcome);
  const outcome =
    primaryOutcome === undefined
      ? null
      : [
          primaryOutcome.text,
          ...followUpOutcomes.map((item) => {
            const label = artifacts.find((a) => a.data.artifact_id === item.source.artifact_id)
              ?.data.label;
            return `Follow-up${label ? ` (${label})` : ''}: ${item.text}`;
          }),
        ].join('\n\n');

  return {
    mode: 'branch-wide',
    branch: input.range.branch,
    base: input.range.base,
    range: {
      base_sha: input.range.base_sha,
      merge_base: input.range.merge_base,
      head: input.range.head_sha,
      commit_count: input.range.commit_count,
    },
    title:
      selected === undefined
        ? null
        : {
            text: selected.text,
            source_artifact_id: selected.artifact_id,
            selection_rule:
              input.primaryArtifactId === undefined
                ? 'earliest_summarized_artifact'
                : 'explicit_primary_artifact',
          },
    title_candidates: candidates,
    artifacts: artifacts.map((artifact) => ({
      id: artifact.data.artifact_id,
      label: artifact.data.label,
      role:
        primaryId === undefined
          ? 'unclassified'
          : artifact.data.artifact_id === primaryId
            ? 'primary'
            : 'follow-up',
      state: artifact.state,
      order: artifact.order,
      is_complete: artifact.data.is_complete,
      origin: artifact.data.origin,
      plan_base_sha: artifact.data.base_sha,
      anchors: artifact.anchors,
      matched_anchors: artifact.matched_anchors,
      relationship: 'in_range',
    })),
    outcome,
    outcomes,
    changes,
    decisions: [...decisionByKey.values()],
    open_items: openItems,
    tests,
    release_checks: releaseChecks,
    warnings,
    policy_exceptions: policyExceptions,
    acknowledged_blocks: acknowledgedBlocks,
    usage: mergeUsage(artifacts),
    incomplete_artifact_ids: artifacts
      .filter((artifact) => !artifact.data.is_complete)
      .map((artifact) => artifact.data.artifact_id),
    excluded_artifacts: [...(input.excludedArtifacts ?? [])],
    unreadable_artifacts: [...(input.unreadableArtifacts ?? [])],
  };
}

function sourceLabel(source: BranchSource): string {
  return [
    `artifact ${source.artifact_id}`,
    source.checkpoint === undefined ? null : `cp ${source.checkpoint}`,
    source.revision_n === undefined ? null : `plan rev ${source.revision_n}`,
  ]
    .filter((part): part is string => part !== null)
    .join(', ');
}

function addEvaluatorRows(
  lines: string[],
  heading: string,
  rows: ReadonlyArray<DigestEvaluatorRow & ({ source: BranchSource } | { sources: BranchSource[] })>
): void {
  if (rows.length === 0) return;
  lines.push(`## ${heading}`, '');
  const passing = rows.filter((row) => row.status === 'pass');
  for (const row of rows.filter((candidate) => candidate.status !== 'pass')) {
    const sources = 'sources' in row ? row.sources : [row.source];
    lines.push(
      `- **${row.status}** \`${row.evaluator_ref}\` (${row.phase}; ${sources.map(sourceLabel).join('; ')})`
    );
    for (const bodyLine of row.body.trim().split('\n')) lines.push(`  > ${bodyLine}`);
  }
  if (passing.length > 0) {
    lines.push(
      `_Passed: ${passing
        .map((row) => {
          const sources = 'sources' in row ? row.sources : [row.source];
          return `\`${row.evaluator_ref}\` (${sources.map(sourceLabel).join('; ')})`;
        })
        .join(', ')}._`
    );
  }
  lines.push('');
}

export function renderBranchDigestMarkdown(data: BranchDigestData): string {
  const lines: string[] = [];
  lines.push(`# ${data.title?.text ?? `Branch digest for ${data.branch}`}`, '');
  lines.push(`> Branch-wide digest for \`${data.branch}\` against \`${data.base}\`.`);
  lines.push(
    `> Range: \`${data.range.merge_base}..${data.range.head}\` (${data.range.commit_count} commits).`,
    ''
  );
  lines.push(`> Base ref resolves to \`${data.range.base_sha}\`.`, '');
  if (data.title !== null) {
    lines.push(
      `> Title source: \`${data.title.source_artifact_id}\` (${data.title.selection_rule}).`,
      ''
    );
  }
  if (data.incomplete_artifact_ids.length > 0) {
    lines.push(
      `> **Incomplete captured work:** ${data.incomplete_artifact_ids.map((id) => `\`${id}\``).join(', ')} has no summary.`,
      ''
    );
  }
  lines.push('## included artifacts', '');
  for (const artifact of data.artifacts) {
    const via = artifact.matched_anchors
      .map((anchor) => (anchor.source === 'checkpoint' ? `cp ${anchor.n}` : anchor.source))
      .join(', ');
    lines.push(
      `- **${artifact.label}** — \`${artifact.id}\` (${artifact.role}, ${artifact.state}; via ${via})`
    );
    lines.push(
      `  - Plan base: \`${artifact.plan_base_sha}\`; recorded boundaries: ${artifact.anchors
        .map(
          (anchor) =>
            `${anchor.source === 'checkpoint' ? `cp ${anchor.n}` : anchor.source} \`${anchor.head_sha}\``
        )
        .join(', ')}`
    );
    if (artifact.origin?.kind === 'git-import') {
      const authors =
        artifact.origin.authors.length > 0 ? artifact.origin.authors.join(', ') : 'unknown';
      lines.push(
        `  - **Imported from Git history (synthesized, not captured reasoning).** Commit authors: ${authors}.`
      );
    }
  }
  lines.push('');
  if (data.title_candidates.length > 0) {
    lines.push('## title candidates', '');
    for (const candidate of data.title_candidates) {
      lines.push(`- ${candidate.text} — \`${candidate.artifact_id}\``);
    }
    lines.push('');
  }
  if (data.outcome !== null) lines.push('## summary', '', data.outcome, '');
  if (data.changes.length > 0) {
    lines.push('## what changed', '');
    for (const change of data.changes) {
      lines.push(`- ${change.summary} _(${sourceLabel(change.source)})_`);
      if (change.files_changed.length > 0) {
        lines.push(`  - Files: ${change.files_changed.map((file) => `\`${file}\``).join(', ')}`);
      }
    }
    lines.push('');
  }
  if (data.decisions.length > 0) {
    lines.push('## decisions', '');
    for (const decision of data.decisions) {
      lines.push(
        `- **${decision.decision}** — ${decision.reason} _(${decision.sources.map(sourceLabel).join('; ')})_`
      );
      for (const alternative of decision.alternatives_considered ?? []) {
        lines.push(`  - Rejected ${alternative.option}: ${alternative.rejected_because}`);
      }
      if (decision.evidence) {
        lines.push(
          `  - Evidence: commit ${decision.evidence.commit_sha} — ${decision.evidence.quote}`
        );
      }
    }
    lines.push('');
  }
  if (data.open_items.length > 0) {
    lines.push('## open items', '');
    for (const item of data.open_items) {
      lines.push(
        `- **${item.kind.replaceAll('_', ' ')}:** ${item.text} _(${item.sources.map(sourceLabel).join('; ')})_`
      );
    }
    lines.push('');
  }
  if (data.tests.length > 0) {
    lines.push('## tests', '');
    for (const test of data.tests) {
      const result = test.exit_code === undefined ? '' : ` — exit ${test.exit_code}`;
      const kind =
        test.kind === 'verification'
          ? 'Verification'
          : test.kind === 'test_run'
            ? 'Test run'
            : 'Test file';
      lines.push(
        `- **${kind}:** \`${test.text}\`${result} _(${test.sources.map(sourceLabel).join('; ')})_`
      );
      if (test.output_digest) lines.push(`  - ${test.output_digest}`);
      if (test.note) lines.push(`  - ${test.note}`);
    }
    lines.push('');
  }
  addEvaluatorRows(lines, 'release checks', data.release_checks);
  addEvaluatorRows(lines, 'warnings', data.warnings);
  if (data.policy_exceptions.length > 0 || data.acknowledged_blocks.length > 0) {
    lines.push('## exceptions and acknowledgements', '');
    for (const exception of data.policy_exceptions) {
      lines.push(
        `- **Policy exception** \`${exception.evaluator_ref}\`: ${exception.reason} _(${sourceLabel(exception.source)})_`
      );
    }
    for (const block of data.acknowledged_blocks) {
      lines.push(
        `- **Acknowledged block** \`${block.evaluator_ref}\`${block.reason ? `: ${block.reason}` : ''} _(${sourceLabel(block.source)})_`
      );
      if (block.original_violation_body) {
        for (const bodyLine of block.original_violation_body.trim().split('\n')) {
          lines.push(`  > ${bodyLine}`);
        }
      }
    }
    lines.push('');
  }
  if (data.excluded_artifacts.length > 0) {
    lines.push('## artifacts not included', '');
    for (const artifact of data.excluded_artifacts) {
      const explanation =
        artifact.reason === 'reachable_out_of_range'
          ? 'recorded commits are reachable but outside the selected range'
          : artifact.reason === 'unreachable_from_head'
            ? 'recorded commits are not reachable from the selected head; they may have been rebased or may belong elsewhere'
            : 'the relationship to the selected range could not be verified';
      lines.push(`- \`${artifact.id}\` — ${explanation} (\`${artifact.reason}\`)`);
    }
    lines.push('');
  }
  if (data.unreadable_artifacts.length > 0) {
    lines.push('## unreadable artifacts', '');
    lines.push(
      'These repository artifacts could not be read, so their relationship to the selected branch is unknown.'
    );
    lines.push('');
    for (const artifact of data.unreadable_artifacts) {
      lines.push(`- \`${artifact.id}\` — relationship unverifiable (\`${artifact.reason}\`)`);
    }
    lines.push('');
  }
  if (data.usage.has_usage) {
    lines.push('## agent usage', '');
    for (const session of data.usage.sessions) {
      lines.push(
        `- \`${session.agent}/${session.session_id}\`: in ${session.input_tokens}, out ${session.output_tokens}, cache-write ${session.cache_creation_input_tokens}, cache-read ${session.cache_read_input_tokens}`
      );
    }
    lines.push('');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}
