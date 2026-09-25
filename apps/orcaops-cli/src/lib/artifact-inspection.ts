import { z } from 'zod';

import { ProjectDatabaseError } from '@orcaops/storage/history/database';

import type { DatabaseShowOptions, readDatabaseShow } from './database-show.js';
import {
  INSPECTION_BYTES,
  inspectionBytes,
  measuredInspection,
  validateExportPath,
} from './inspection-output.js';

type Reading = Awaited<ReturnType<typeof readDatabaseShow>>;
const Sections = z.enum(['plan', 'knowledge', 'summary', 'evaluators', 'usage', 'repository']);
const Anchor = z.strictObject({
  project: z.string().uuid(),
  store: z.string().uuid(),
  artifact: z.string().uuid(),
  boundary: z.number().int().nonnegative().nullable(),
  counters: z.strictObject({
    writeSequence: z.number().int().nonnegative(),
    intentChangeCounter: z.number().int().nonnegative(),
  }),
});
const Cursor = z.strictObject({
  anchor: Anchor,
  offset: z.number().int().nonnegative(),
  limit: z.number().int().min(1).max(20),
});
export interface ArtifactInspectionOptions extends DatabaseShowOptions {
  checkpoint?: number;
  section?: string;
  decision?: number;
  limit?: number;
  cursor?: string;
  anchor?: string;
  output?: string;
}
const encode = (prefix: string, value: object) =>
  `${prefix}.${Buffer.from(JSON.stringify(value)).toString('base64url')}`;
function decode<T>(token: string, prefix: string, schema: z.ZodType<T>): T {
  try {
    if (
      token.length > 4096 ||
      !token.startsWith(prefix + '.') ||
      !/^[A-Za-z0-9_-]+$/.test(token.slice(prefix.length + 1))
    )
      throw new Error();
    return schema.parse(
      JSON.parse(Buffer.from(token.slice(prefix.length + 1), 'base64url').toString('utf8'))
    );
  } catch {
    throw new ProjectDatabaseError(
      'INVALID_INPUT',
      'Invalid artifact inspection reference. Repeat show for a fresh selection.'
    );
  }
}

export function artifactInspectionOptions(options: ArtifactInspectionOptions) {
  const cursor = options.cursor ? decode(options.cursor, 'artifact-page1', Cursor) : undefined;
  const anchor = options.anchor ? decode(options.anchor, 'artifact1', Anchor) : cursor?.anchor;
  if (options.cursor && options.anchor)
    throw new ProjectDatabaseError('INVALID_INPUT', 'Use either --cursor or --anchor, not both.');
  for (const value of [options.checkpoint, options.decision, options.limit])
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 1))
      throw new ProjectDatabaseError(
        'INVALID_INPUT',
        'Checkpoint, decision, and page limits must be positive integers.'
      );
  if ((options.limit ?? 5) > 20)
    throw new ProjectDatabaseError('INVALID_INPUT', 'Checkpoint pages are limited to 20 rows.');
  if (options.section && !Sections.safeParse(options.section).success)
    throw new ProjectDatabaseError(
      'INVALID_INPUT',
      'Unknown artifact section. Use plan, knowledge, summary, evaluators, usage, or repository.'
    );
  const focused = [options.section, options.checkpoint, options.decision].filter(
    (v) => v !== undefined
  ).length;
  if (
    focused > 1 ||
    (options.cursor && (focused || options.output)) ||
    (options.limit !== undefined && (focused || options.output))
  )
    throw new ProjectDatabaseError(
      'INVALID_INPUT',
      'Use checkpoint pagination, one exact selector, or whole-artifact export separately.'
    );
  if (
    anchor &&
    ((options.project && options.project !== anchor.project) ||
      (options.atBoundary !== undefined && options.atBoundary !== anchor.boundary))
  )
    throw new ProjectDatabaseError(
      'INVALID_INPUT',
      'The inspection reference names a different project or knowledge boundary.'
    );
  if (cursor && options.limit !== undefined && cursor.limit !== options.limit)
    throw new ProjectDatabaseError('INVALID_INPUT', 'Continue with the original page size.');
  validateExportPath(options.output);
  return {
    read: {
      project: options.project ?? anchor?.project,
      atBoundary: options.atBoundary ?? anchor?.boundary ?? undefined,
      json: options.json,
    },
    anchor,
    offset: cursor?.offset ?? 0,
    limit: cursor?.limit ?? options.limit ?? 5,
  };
}

export function artifactInspection(reading: Reading, options: ArtifactInspectionOptions) {
  const request = artifactInspectionOptions(options);
  const artifact = reading.artifact;
  const authority = reading.scope.authorities.find((a) => a.project_id === artifact.project_id)!;
  const anchor = Anchor.parse({
    project: artifact.project_id,
    store: authority.store_instance_id,
    artifact: artifact.id,
    boundary: request.read.atBoundary ?? null,
    counters: reading.sources[0]!.counters,
  });
  if (request.anchor && JSON.stringify(request.anchor) !== JSON.stringify(anchor))
    throw new ProjectDatabaseError(
      'STALE_CONTEXT',
      'The artifact selection or history observation changed. Repeat show for a fresh selection.'
    );
  const reference = encode('artifact1', anchor);
  const command = `orcaops show ${artifact.id} --project ${artifact.project_id} --anchor ${reference}`;
  const omissions: { section: string; bytes: number; inspect: string }[] = [];
  const base = {
    schema_version: 4 as const,
    representation: 'digest' as const,
    artifact: {
      id: artifact.id,
      project_id: artifact.project_id,
      branch: artifact.branch,
      state: artifact.state,
    },
    selection: { reference, historical_boundary: anchor.boundary, observation: anchor.counters },
    completeness: reading.completeness,
  };
  const exportValue = {
    ...reading,
    schema_version: 4,
    representation: 'artifact_export',
    selection: base.selection,
    results: undefined,
  };
  let content: unknown;
  let selector = '';
  if (options.checkpoint !== undefined) {
    content = artifact.checkpoints.find((cp) => cp.n === options.checkpoint);
    selector = `--checkpoint ${options.checkpoint}`;
  } else if (options.decision !== undefined) {
    content = artifact.plan?.decisions[options.decision - 1];
    selector = `--decision ${options.decision}`;
  } else if (options.section) {
    const sections = {
      plan: artifact.plan,
      knowledge: artifact.knowledge,
      summary: artifact.summary,
      evaluators: artifact.evaluator_log,
      usage: artifact.usage,
      repository: {
        repo_state: artifact.repo_state,
        git_context: artifact.git_context,
        related_evidence: artifact.related_evidence,
        branch_lineage: artifact.branch_lineage,
        lineage_sha_drift: artifact.lineage_sha_drift,
      },
    };
    content = sections[Sections.parse(options.section)];
    selector = `--section ${options.section}`;
  }
  if (selector) {
    if (content === undefined)
      throw new ProjectDatabaseError(
        'INVALID_INPUT',
        'The selected checkpoint or decision does not exist.'
      );
    const complete = {
      ...base,
      representation: 'inspection' as const,
      selector,
      status: 'available' as const,
      content,
    };
    const exportCommand = `${command} ${selector} --output <file> --json`;
    return {
      exportValue: complete,
      response:
        inspectionBytes(complete) + 128 <= INSPECTION_BYTES
          ? measuredInspection(complete)
          : measuredInspection({
              ...base,
              representation: 'inspection' as const,
              selector,
              status: 'omitted_oversized' as const,
              content: null,
              reason:
                'The complete unit exceeds the stdout allowance; no wording or qualifications were clipped.',
              content_bytes: inspectionBytes({ content }),
              export: exportCommand,
            }),
    };
  }
  if (options.output)
    return {
      exportValue,
      response: measuredInspection({ ...base, representation: 'export' as const }),
    };
  const unit = <T>(value: T, section: string, inspect: string, allowance: number): T | null => {
    const bytes = inspectionBytes({ content: value });
    if (bytes <= allowance) return value;
    omissions.push({ section, bytes, inspect });
    return null;
  };
  const checkpoints = [...artifact.checkpoints].sort((a, b) => a.n - b.n);
  if (request.offset > checkpoints.length)
    throw new ProjectDatabaseError('INVALID_INPUT', 'Checkpoint offset is outside this artifact.');
  const rows = checkpoints.slice(request.offset, request.offset + request.limit).map((cp) => ({
    n: cp.n,
    status: cp.status,
    recorded_at:
      cp.status === 'closed' ? cp.closed_at : cp.status === 'open' ? cp.opened_at : cp.abandoned_at,
    summary: unit(
      cp.status === 'closed' ? cp.summary : cp.status === 'abandoned' ? cp.reason : null,
      `checkpoint:${cp.n}`,
      `${command} --checkpoint ${cp.n} --json`,
      384
    ),
  }));
  const end = request.offset + rows.length;
  const next =
    end < checkpoints.length
      ? encode('artifact-page1', { anchor, offset: end, limit: request.limit })
      : null;
  const response = {
    ...base,
    task: unit(artifact.task, 'task', `${command} --output <file> --json`, 768),
    label: unit(artifact.label, 'label', `${command} --output <file> --json`, 512),
    origin: artifact.origin?.kind ?? null,
    source_plan: unit(
      artifact.source_plan,
      'source_plan',
      `${command} --output <file> --json`,
      768
    ),
    decisions: (artifact.plan?.decisions ?? []).slice(0, 3).map((decision, index) => ({
      n: index + 1,
      content: unit(
        decision,
        `decision:${index + 1}`,
        `${command} --decision ${index + 1} --json`,
        1024
      ),
    })),
    decision_count: artifact.plan?.decisions.length ?? 0,
    checkpoints: rows,
    pagination: {
      total: checkpoints.length,
      offset: request.offset,
      limit: request.limit,
      next_cursor: next,
      next: next ? `orcaops show ${artifact.id} --cursor ${next} --json` : null,
    },
    omissions,
    follow_up: {
      checkpoint: `${command} --checkpoint <n> --json`,
      decision: `${command} --decision <n> --json`,
      knowledge: `${command} --section knowledge --json`,
      export: `${command} --output <file> --json`,
    },
    authority:
      'Digest entries describe recorded history, not current obligations. Inspect knowledge for governing requirements and qualifications.',
  };
  return { exportValue, response: measuredInspection(response) };
}

export function renderArtifactInspection(
  response: ReturnType<typeof artifactInspection>['response']
): string {
  const lines = [`Artifact ${response.artifact.id} (${response.artifact.state})`];
  if (!response.completeness.complete)
    lines.push(
      'History coverage is incomplete; this is not an exhaustive account. Inspect the JSON completeness warnings before relying on missing evidence.'
    );
  if (response.representation === 'digest') {
    lines.push(`Task: ${response.task ?? '(omitted; inspect export)'}`);
    if (response.origin === 'git-import')
      lines.push('Origin: imported from git history (synthesized)');
    if (response.source_plan) {
      const ref = response.source_plan.source_ref;
      lines.push(
        `Source plan: ${ref.kind === 'cloud' ? `cloud:${ref.locator}@${ref.version}` : `${ref.locator} (local)`}`
      );
    }
    if (response.decisions.length)
      lines.push(
        '',
        `Decisions: ${response.decisions.length} of ${response.decision_count} shown (recorded)`
      );
    for (const item of response.decisions) {
      if (!item.content) {
        lines.push(`  ${item.n}. Omitted oversized decision; inspect --decision ${item.n}.`);
        continue;
      }
      const decision = item.content;
      lines.push(
        `  ${item.n}. ${decision.decision}  (plan rev ${decision.revision_n})`,
        `     ${decision.reason}`
      );
      for (const alternative of decision.alternatives_considered ?? [])
        lines.push(
          `     considered ${alternative.option} — rejected because ${alternative.rejected_because}`
        );
    }
    if (response.decisions.length < response.decision_count)
      lines.push(
        `  ${response.decision_count - response.decisions.length} more; inspect exactly with ${response.follow_up.decision} ` +
          `(n=${response.decisions.length + 1}–${response.decision_count}).`
      );
    lines.push(
      '',
      `Checkpoint index (${response.checkpoints.length} of ${response.pagination.total}):`
    );
    for (const cp of response.checkpoints)
      lines.push(
        `  #${cp.n} [${cp.status}] Agent-reported: ${cp.summary ?? '(body not displayed)'}`
      );
    lines.push('', response.authority);
    if (response.omissions.length)
      lines.push(
        `${response.omissions.length} bodies omitted without clipping qualifications.`,
        ...response.omissions.map((item) => `${item.section}: ${item.inspect}`)
      );
    if (response.pagination.next) lines.push(`Next page: ${response.pagination.next}`);
    lines.push(
      `Inspect checkpoint: ${response.follow_up.checkpoint}`,
      `Inspect decision: ${response.follow_up.decision}`,
      `Inspect authority: ${response.follow_up.knowledge}`,
      `Export: ${response.follow_up.export}`
    );
  } else if ('content' in response) {
    lines.push(
      'Recorded evidence; verification is agent-reported.',
      JSON.stringify(response, null, 2)
    );
  } else lines.push(JSON.stringify(response));
  const text = lines.join('\n') + '\n';
  return Buffer.byteLength(text) <= INSPECTION_BYTES ? text : JSON.stringify(response) + '\n';
}
