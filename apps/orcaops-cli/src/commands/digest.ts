import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  BranchDigestInputError,
  buildArchivedDigest,
  buildBranchDigestData,
  buildDigest,
  renderBranchDigestMarkdown,
  writeDigest,
} from '@orcaops/core';
import { discoverEvaluators } from '@orcaops/evaluator-runner';

import { ErrorCodes, OrcaopsError } from '../io/errors.js';
import { CliExit } from '../io/exit.js';
import {
  emitError,
  emitOk,
  writeErrorLine,
  writePipeFriendlyStdout,
  writeTerminalSafeStderr,
  writeTerminalSafeStdout,
} from '../io/output.js';
import { IMPORTED_BADGE, resolveBranchReadScope } from '../lib/artifact-scope.js';
import { buildContext } from '../lib/context.js';
import { readForEnumeration } from '../lib/enumeration-read.js';
import { CLI_ROOT } from '../lib/evaluators-config.js';
import { fallbackState } from '../lib/lifecycle-state.js';
import {
  formatProjectScopeWarnings,
  openCurrentProjectArchive,
  type ProjectHandle,
} from '../lib/project-scope.js';
import { resolveBranchDigestRange, selectArtifactsInRange } from '../lib/range-artifacts.js';

export interface DigestOptions {
  artifact?: string;
  /** Positional artifact id — equivalent to `--artifact`; both must agree. */
  artifactArg?: string;
  branch?: string;
  out?: string;
  format?: 'md' | 'json';
  json?: boolean;
  branchWide?: boolean;
  base?: string;
  primaryArtifact?: string;
}

export const DIGEST_SIBLING_LIMIT = 20;

export function selectDigestSiblingRows<T extends { origin_kind?: 'git-import' | null }>(
  rows: readonly T[]
): T[] {
  return [
    ...rows.filter((row) => row.origin_kind !== 'git-import'),
    ...rows.filter((row) => row.origin_kind === 'git-import'),
  ].slice(0, DIGEST_SIBLING_LIMIT);
}

/**
 * `orcaops digest` — render reviewer-facing captured work.
 *
 * Resolution order for which artifact to digest:
 *   1. --artifact <id> (explicit)
 *   2. --branch <name> → latest active artifact on that branch
 *   3. current branch  → latest active artifact on it
 *
 * Output:
 *   - --format md (default) prints markdown to stdout (or --out file).
 *   - --format json prints { ok, data, markdown } envelope.
 *   - --json is shorthand for --format json.
 *
 * Artifact mode always writes `<artifact>/digest.md`. Branch-wide mode is
 * read-only unless --out is supplied and never creates a search entry.
 */
export async function digestAction(opts: DigestOptions = {}): Promise<void> {
  const wantJson = opts.json || opts.format === 'json';
  try {
    if (
      opts.artifact !== undefined &&
      opts.artifactArg !== undefined &&
      opts.artifact !== opts.artifactArg
    ) {
      throw new OrcaopsError(
        ErrorCodes.INVALID_INPUT,
        `Conflicting artifact ids: positional "${opts.artifactArg}" vs --artifact "${opts.artifact}".`
      );
    }
    if (opts.artifactArg !== undefined) {
      opts = { ...opts, artifact: opts.artifact ?? opts.artifactArg };
    }
    if (
      opts.branchWide !== true &&
      (opts.base !== undefined || opts.primaryArtifact !== undefined)
    ) {
      throw new OrcaopsError(
        ErrorCodes.INVALID_INPUT,
        '--base and --primary-artifact require --branch-wide.'
      );
    }
    if (opts.branchWide === true && opts.artifact !== undefined) {
      throw new OrcaopsError(
        ErrorCodes.INVALID_INPUT,
        '--branch-wide cannot be combined with an artifact selector.',
        'artifact'
      );
    }
    const ctx = await buildContext({ mintArchiveIdentity: false });
    try {
      if (opts.branchWide === true) {
        await runBranchWideDigest(ctx, opts, wantJson);
        return;
      }
      const resolved = await resolveDigestArtifact(ctx, opts);
      const artifactId = resolved.artifactId;

      // Pull evaluator descriptions for the process-notes section.
      // Lenient mode — a misconfigured pack shouldn't prevent the
      // digest from rendering (doctor surfaces those errors).
      const { evaluators } = await discoverEvaluators(ctx.repoRoot, {
        cliRoot: CLI_ROOT,
        onError: () => undefined,
      });
      const descriptions = new Map<string, string>();
      for (const e of evaluators) {
        if (e.description !== undefined) descriptions.set(e.ref, e.description);
      }

      const result = await writeDigest({
        store: ctx.store,
        artifactId,
        evaluatorDescriptions: descriptions,
        redactSecrets: ctx.config.digest.redact_secrets,
      });

      // Selection disclosures — additive JSON fields; human
      // one-liners go to stderr so piped markdown stays clean.
      const selectionFields = {
        ...(resolved.note !== undefined ? { note: resolved.note } : {}),
        ...(resolved.otherArtifacts.length > 0 ? { other_artifacts: resolved.otherArtifacts } : {}),
        ...(resolved.otherArtifactCount > 0
          ? {
              other_artifact_count: resolved.otherArtifactCount,
              other_artifacts_truncated:
                resolved.otherArtifactCount > resolved.otherArtifacts.length,
            }
          : {}),
      };
      const emitHumanSelectionNotes = (): void => {
        if (resolved.note !== undefined) writeTerminalSafeStderr(`note: ${resolved.note}\n`);
        if (resolved.otherArtifactCount > 0) {
          writeTerminalSafeStderr(
            `note: ${resolved.otherArtifactCount} other artifact(s) on this branch not ` +
              `digested: ${resolved.otherArtifacts
                .map(
                  (a) =>
                    `${a.id.slice(0, 8)}${a.origin === 'git-import' ? ` ${IMPORTED_BADGE}` : ''} ` +
                    `(${a.state ?? 'unreadable'})`
                )
                .join(', ')}` +
              (resolved.otherArtifactCount > resolved.otherArtifacts.length
                ? `, … showing ${resolved.otherArtifacts.length}`
                : '') +
              ' — pass --artifact <id> to digest one of them\n'
          );
        }
      };

      if (opts.out) {
        const outPath = path.resolve(opts.out);
        const payload = wantJson
          ? JSON.stringify({ ok: true, data: result.data, markdown: result.markdown }, null, 2) +
            '\n'
          : result.markdown;
        await writeFile(outPath, payload, 'utf8');
        if (wantJson) {
          emitOk({
            artifact_id: result.data.artifact_id,
            written_to: outPath,
            cached_at: result.path,
            ...selectionFields,
          });
        } else {
          emitHumanSelectionNotes();
          writeTerminalSafeStdout(`Wrote digest → ${outPath}\n(cached: ${result.path})\n`);
        }
        return;
      }

      if (wantJson) {
        emitOk({
          artifact_id: result.data.artifact_id,
          cached_at: result.path,
          data: result.data,
          markdown: result.markdown,
          ...selectionFields,
        });
        return;
      }

      emitHumanSelectionNotes();
      writePipeFriendlyStdout(result.markdown);
    } finally {
      ctx.store.close();
    }
  } catch (err) {
    if (wantJson) emitError(err);
    writeErrorLine(err);
    throw new CliExit(1);
  }
}

async function evaluatorDescriptions(repoRoot: string): Promise<ReadonlyMap<string, string>> {
  const { evaluators } = await discoverEvaluators(repoRoot, {
    cliRoot: CLI_ROOT,
    onError: () => undefined,
  });
  const descriptions = new Map<string, string>();
  for (const evaluator of evaluators) {
    if (evaluator.description !== undefined) descriptions.set(evaluator.ref, evaluator.description);
  }
  return descriptions;
}

async function runBranchWideDigest(
  ctx: Awaited<ReturnType<typeof buildContext>>,
  opts: DigestOptions,
  wantJson: boolean
): Promise<void> {
  const range = await resolveBranchDigestRange({ ctx, branch: opts.branch, base: opts.base });
  const archive = await openCurrentProjectArchive(ctx.repo, ctx.repoRoot);
  const project: ProjectHandle = {
    projectId: archive?.projectId ?? 'current',
    displayName: archive?.displayName ?? ctx.repoRoot,
    store: ctx.store.store,
    hot: true,
    hotStore: ctx.store,
    ...(archive === null
      ? {}
      : {
          archiveStore: archive.store,
          archiveMeta: archive.meta,
          issues: archive.issues,
        }),
    projectDir: archive?.projectDir ?? ctx.repoRoot,
    issues: archive?.issues ?? [],
    close: () => {},
  };
  const scopeWarning = formatProjectScopeWarnings(project.issues);
  if (scopeWarning.length > 0) writeTerminalSafeStderr(scopeWarning);
  try {
    const selected = await selectArtifactsInRange({
      ctx,
      project,
      fromSha: range.merge_base,
      toSha: range.head_sha,
      localBranch: range.branch,
      operation: 'digest --branch-wide',
    });
    if (selected.matched.length === 0) {
      throw new OrcaopsError(
        ErrorCodes.UNKNOWN_ARTIFACT,
        `No artifacts have recorded work in ${range.merge_base}..${range.head_sha}.`
      );
    }
    const descriptions = await evaluatorDescriptions(ctx.repoRoot);
    const artifacts = await Promise.all(
      selected.matched.map(async (artifact) => ({
        data:
          artifact.projection.source === 'hot'
            ? (
                await buildDigest({
                  store: ctx.store,
                  artifactId: artifact.id,
                  evaluatorDescriptions: descriptions,
                  redactSecrets: ctx.config.digest.redact_secrets,
                })
              ).data
            : buildArchivedDigest({
                thread: artifact.projection.thread,
                store: artifact.projection.store,
                evaluatorDescriptions: descriptions,
                redactSecrets: ctx.config.digest.redact_secrets,
              }).data,
        state: artifact.state,
        order: artifact.order,
        anchors: artifact.anchors,
        matched_anchors: artifact.matched_anchors,
      }))
    );
    let data: ReturnType<typeof buildBranchDigestData>;
    try {
      data = buildBranchDigestData({
        range: {
          branch: range.branch,
          base: range.base,
          base_sha: range.base_sha,
          merge_base: range.merge_base,
          head_sha: range.head_sha,
          commit_count: selected.commit_shas.length,
        },
        artifacts,
        primaryArtifactId: opts.primaryArtifact,
        excludedArtifacts: selected.candidates
          .filter((candidate) => candidate.kind === 'lineage_candidate')
          .map((candidate) => ({
            id: candidate.id,
            reason: candidate.reason,
          })),
        unreadableArtifacts: selected.candidates
          .filter((candidate) => candidate.kind === 'unreadable')
          .map((candidate) => ({ id: candidate.id, reason: 'unverifiable' })),
      });
    } catch (error) {
      if (error instanceof BranchDigestInputError) {
        throw new OrcaopsError(ErrorCodes.INVALID_INPUT, error.message, 'primary-artifact');
      }
      throw error;
    }
    const markdown = renderBranchDigestMarkdown(data);
    if (opts.out) {
      const outPath = path.resolve(opts.out);
      const payload = wantJson
        ? `${JSON.stringify({ ok: true, data, markdown }, null, 2)}\n`
        : markdown;
      await writeFile(outPath, payload, 'utf8');
      if (wantJson) emitOk({ mode: 'branch-wide', written_to: outPath });
      else writeTerminalSafeStdout(`Wrote branch-wide digest → ${outPath}\n`);
      return;
    }
    if (wantJson) {
      emitOk({ data, markdown });
      return;
    }
    writePipeFriendlyStdout(markdown);
  } finally {
    archive?.close();
  }
}

interface ResolvedDigestArtifact {
  artifactId: string;
  /** Set when the default resolution fell back to an artifact with no summary. */
  note?: string;
  /** Sibling artifacts on the branch NOT digested (empty under --artifact). */
  otherArtifacts: Array<{
    id: string;
    state: string | null;
    unreadable?: true;
    label?: string;
    origin: 'git-import' | null;
  }>;
  otherArtifactCount: number;
}

/**
 * Default artifact selection is summary-aware: prefer the newest
 * artifact WITH a captured summary (the internal coarse
 * `status === 'complete'` column); else the newest
 * active one with an explicit "in-flight, no summary yet" note. When
 * the branch has more than one artifact, the siblings are listed so a
 * reviewer never silently reads the wrong thread. `--artifact` bypass
 * unchanged.
 */
async function resolveDigestArtifact(
  ctx: Awaited<ReturnType<typeof buildContext>>,
  opts: DigestOptions
): Promise<ResolvedDigestArtifact> {
  if (opts.artifact) {
    const row = ctx.store.store.getArtifact(opts.artifact);
    if (!row) {
      throw new OrcaopsError(
        ErrorCodes.UNKNOWN_ARTIFACT,
        `No artifact with id "${opts.artifact}".`
      );
    }
    return { artifactId: opts.artifact, otherArtifacts: [], otherArtifactCount: 0 };
  }
  // Seeded participation (storage-class rule, decided explicitly): imported
  // artifacts join the default pool as last-resort digest targets and
  // disclosed siblings; live work always outranks them below.
  const scope = await resolveBranchReadScope(ctx, { branch: opts.branch }, { imported: 'include' });
  const branch = scope.branch!;
  const rows = scope.rows;
  if (rows.length === 0) {
    throw new OrcaopsError(
      ErrorCodes.UNKNOWN_ARTIFACT,
      `No artifacts found on branch "${branch}". Capture a plan first.`
    );
  }
  const liveRows = rows.filter((row) => row.origin_kind !== 'git-import');
  const chosen =
    liveRows.find((r) => r.status === 'complete') ??
    liveRows.find((r) => r.status === 'active') ??
    rows.find((r) => r.status === 'complete') ??
    rows.find((r) => r.status === 'active') ??
    rows[0];
  const siblingRows = rows.filter((row) => row.id !== chosen.id);
  const visibleSiblingRows = selectDigestSiblingRows(siblingRows);
  const otherArtifacts = await Promise.all(
    visibleSiblingRows.map(async (r) => {
      const read = await readForEnumeration(r.id, 'digest sibling list', () =>
        ctx.store.readArtifact(r.id)
      );
      return {
        id: r.id,
        // Unreadable ⇒ unknown, never a substituted state.
        state: read.kind === 'unreadable' ? null : (read.value?.state ?? fallbackState(r.status)),
        ...(read.kind === 'unreadable' ? { unreadable: true as const } : {}),
        ...(r.label !== undefined ? { label: r.label } : {}),
        origin: r.origin_kind ?? null,
      };
    })
  );
  return {
    artifactId: chosen.id,
    ...(chosen.status !== 'complete'
      ? {
          note:
            `artifact ${chosen.id} is in-flight (no summary captured yet) — ` +
            `the digest reflects work in progress`,
        }
      : {}),
    otherArtifacts,
    otherArtifactCount: siblingRows.length,
  };
}
