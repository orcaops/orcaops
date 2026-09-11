import { randomUUID } from 'node:crypto';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { diffSnapshotTrees, EMPTY_TREE_SHA, lineContentMatch } from '@orcaops/core';
import { stringifyTerminalSafeJson } from '@orcaops/evaluator-protocol/terminal';
import { redactSecretsInObject } from '@orcaops/storage';

import { ErrorCodes, OrcaopsError } from '../io/errors.js';
import { CliExit } from '../io/exit.js';
import { emitError, emitOk, writeErrorLine, writeTerminalSafeStderr } from '../io/output.js';
import { CLI_VERSION } from '../lib/cli-version.js';
import {
  createContextRevalidator,
  historyRepository,
  requireRepositoryScope,
} from '../lib/database-branch-history.js';
import { loadDiffManifests, readProjectDiffArtifacts } from '../lib/database-diff.js';
import {
  type DatabaseExportOptions,
  dominantExportModel,
  exportArtifactOrigins,
  readExportUsageSnapshots,
  validateDatabaseExport,
} from '../lib/database-export.js';
import { resolveDatabaseHistoryCommandContext } from '../lib/database-history-context.js';
import { classifyOverlapMatch } from '../lib/database-manifest-sources.js';
import { closeFailedHistoryRead } from '../lib/history-reader-close.js';
import { historyScopeCommandError } from '../lib/history-scope-error.js';
import { parseAddedLines, toRanges } from '../lib/history-trace-views.js';

/** Our own documented notes namespace. NEVER git-ai's refs/notes/ai. */
export const AGENT_TRACE_NOTES_REF = 'refs/notes/orcaops/agent-trace';

export type ExportAgentTraceOptions = DatabaseExportOptions;

/**
 * models.dev-style slug from a raw model name (best-effort; agent-trace's
 * `model_id` example convention). Unknown vendors pass through raw.
 */
function toModelSlug(model: string): string {
  if (model.startsWith('claude')) return `anthropic/${model}`;
  if (model.startsWith('gpt') || /^o\d/.test(model)) return `openai/${model}`;
  if (model.startsWith('gemini')) return `google/${model}`;
  return model;
}

/**
 * `orcaops export agent-trace [--commit <sha>] [--out <path>] [--notes] [--json]`
 *
 * Emit per-line provenance for one commit as a Cursor **agent-trace
 * v0.1.0** `TraceRecord` (the portable, storage-agnostic record schema —
 * agentskills ecosystem interop is the point). Attribution is LINE-level
 * `added_line_hashes` membership against checkpoint manifests; ranges
 * are new-side positions at `vcs.revision`, valid by construction.
 *
 * Output defaults to STDOUT — an in-repo default file would re-create
 * a self-fingerprinting leak (and `.agent-trace/` is
 * scrubbed from snapshot trees as belt-and-suspenders for users who
 * follow the reference-impl convention via `--out`).
 *
 * `--notes` attaches the record at `refs/notes/orcaops/agent-trace` —
 * our OWN namespace, never git-ai's actively-rewritten `refs/notes/ai`,
 * and NEVER auto-pushed (distribute deliberately:
 * `git push origin refs/notes/orcaops/agent-trace`).
 */
export async function exportAgentTraceAction(opts: ExportAgentTraceOptions): Promise<void> {
  try {
    const prepared = validateDatabaseExport(opts);
    const context = await resolveDatabaseHistoryCommandContext({
      profile: 'git-history',
      selector: prepared.selector,
    });
    try {
      const { git } = requireRepositoryScope(context.scope);
      const revalidate = createContextRevalidator(context.scope);
      const repo = historyRepository(git.worktreeRoot);
      await revalidate();
      const commitRef = opts.commit !== undefined && opts.commit.length > 0 ? opts.commit : 'HEAD';
      const commitSha = await repo.resolveCommit(commitRef);
      if (commitSha === null) {
        throw new OrcaopsError(
          ErrorCodes.INVALID_INPUT,
          `--commit "${commitRef}" does not resolve to a commit.`,
          'commit'
        );
      }
      const parentSha = (await repo.resolveCommit(`${commitSha}^`)) ?? EMPTY_TREE_SHA;

      const cap = context.config.diff_fingerprint.max_diff_bytes;
      const diff = await diffSnapshotTrees({
        repo,
        openTreeSha: parentSha,
        closeTreeSha: commitSha,
        maxDiffBytes: cap,
      });
      if (!diff.ok) {
        throw new OrcaopsError(
          ErrorCodes.INVALID_INPUT,
          `git diff for commit ${commitSha.slice(0, 12)} failed.`,
          'commit'
        );
      }

      // Manifest sourcing over EVERY artifact in the store — a commit may
      // carry work from any branch's artifacts; sourcing is cheap and the
      // coverage block discloses what was available.
      await revalidate();
      const pool = readProjectDiffArtifacts(context);
      const candidates = pool.artifacts;
      const {
        sources,
        manifestless,
        incompatibleCount,
        overlapAdjudications,
        skippedUnreadableArtifacts,
      } = await loadDiffManifests(context, candidates, pool.skipped);
      // FAIL CLOSED: agent-trace attribution pools every artifact; a
      // skipped one shrinks the ambiguity pool and could promote a
      // shared line to a confident single-artifact attribution.
      if (skippedUnreadableArtifacts.length > 0) {
        throw new OrcaopsError(
          ErrorCodes.INTERNAL,
          `export cannot attribute: artifact(s) ${skippedUnreadableArtifacts.join(', ')} ` +
            `could not be read, so the ambiguity pool would be incomplete. ` +
            `Run \`orcaops doctor\` to see the corruption.`
        );
      }

      const added = parseAddedLines(Buffer.from(diff.diff).toString('utf8'));

      // Per-line membership, memoized by content (identical lines hash once).
      const memo = new Map<
        string,
        {
          trivial: boolean;
          matches: Array<{ artifact_id: string; checkpoint_n: number; manifest_files: string[] }>;
        }
      >();
      const matchLine = async (text: string) => {
        const cached = memo.get(text);
        if (cached !== undefined) return cached;
        const result = await lineContentMatch(sources, text);
        memo.set(text, result);
        return result;
      };

      // Group attributed lines per file per (artifact, checkpoint).
      // Multi-artifact matches are AMBIGUOUS — trivially shared content —
      // and stay unattributed (disclosed in coverage).
      const byFile = new Map<string, Map<string, number[]>>();
      let attributed = 0;
      let ambiguous = 0;
      let trivial = 0;
      let overlapWeak = 0;
      let provisional = 0;
      let crossFileLines = 0;
      for (const line of added) {
        const result = await matchLine(line.text);
        if (result.trivial) {
          trivial += 1;
          continue;
        }
        if (result.matches.length === 0) continue;
        // Prefer sources whose manifest carried
        // the hash under THIS file; only a cross-file-only match falls
        // back to the full pool, and it emits a distinct match kind.
        const sameFilePool = result.matches.filter((m) => m.manifest_files.includes(line.file));
        const pool = sameFilePool.length > 0 ? sameFilePool : result.matches;
        const crossFileOnly = sameFilePool.length === 0;
        const artifactIds = new Set(pool.map((m) => m.artifact_id));
        if (artifactIds.size > 1) {
          ambiguous += 1;
          continue;
        }
        const top = pool[0]; // newest-first within the artifact
        // Overlap adjudication lowers agent-trace confidence.
        // ambiguous/mixed_segment files are WEAK — never emitted as clean
        // attribution; own_claim_pending stays attributed but is counted
        // as provisional (disclosed in coverage).
        const overlapStatus = classifyOverlapMatch(
          overlapAdjudications.get(`${top.artifact_id}:${top.checkpoint_n}`),
          line.file
        );
        if (overlapStatus === 'ambiguous' || overlapStatus === 'mixed_segment') {
          ambiguous += 1;
          overlapWeak += 1;
          continue;
        }
        if (overlapStatus === 'own_claim_pending') provisional += 1;
        attributed += 1;
        if (crossFileOnly) crossFileLines += 1;
        // Kind rides the grouping key so same-file and cross-file
        // ranges of one checkpoint emit as separate conversations with
        // distinct match kinds.
        const key = `${top.artifact_id}:${top.checkpoint_n}:${crossFileOnly ? 'cross_file' : 'same_file'}`;
        const perFile = byFile.get(line.file) ?? new Map<string, number[]>();
        const lines = perFile.get(key) ?? [];
        lines.push(line.line);
        perFile.set(key, lines);
        byFile.set(line.file, perFile);
      }

      // Contributor honesty for imported history: a git-import checkpoint
      // replays a commit orcaops never watched being written, so its
      // contributor is the recorded commit-author set from the artifact
      // origin — asserting `ai` would fabricate authorship testimony.
      const originByArtifact = exportArtifactOrigins(candidates);
      const usageSnapshots = readExportUsageSnapshots(context);

      const files = [...byFile.entries()].map(([filePath, perCp]) => ({
        path: filePath,
        conversations: [...perCp.entries()].map(([key, lineNumbers]) => {
          const [artifactId, nStr, kind] = key.split(':');
          const checkpointN = Number.parseInt(nStr, 10);
          const recorded = originByArtifact.get(artifactId);
          const imported = recorded?.origin === 'git-import';
          const model = imported
            ? null
            : dominantExportModel(usageSnapshots, artifactId, checkpointN);
          const authors = recorded?.authors ?? [];
          return {
            contributor: imported
              ? {
                  type: 'human' as const,
                  ...(authors.length > 0 ? { authors } : {}),
                }
              : {
                  type: 'ai' as const,
                  ...(model !== null ? { model_id: toModelSlug(model) } : {}),
                },
            // Additive marker matching the other read surfaces' disclosure:
            // this conversation's provenance is synthesized from git history.
            ...(imported ? { origin: 'git-import' as const } : {}),
            ranges: toRanges(lineNumbers),
            // Additive to the v0.1.0 record — cross-file-only
            // matches (content found under a different manifest path)
            // carry a distinct kind so consumers can weigh them.
            match_kind: kind === 'cross_file' ? 'line_content_cross_file' : 'line_content',
            related: [
              {
                type: 'session',
                url: `orcaops://artifact/${artifactId}/checkpoint/${checkpointN}`,
              },
            ],
          };
        }),
      }));

      const record = {
        version: '0.1.0',
        id: randomUUID(),
        timestamp: new Date().toISOString(),
        vcs: { type: 'git' as const, revision: commitSha },
        tool: { name: 'orcaops', version: CLI_VERSION },
        files,
        metadata: {
          'ai.orcaops': {
            coverage: {
              added_lines: added.length,
              attributed_lines: attributed,
              ambiguous_lines: ambiguous,
              trivial_lines: trivial,
              unattributed_lines: added.length - attributed - ambiguous - trivial,
              manifestless_checkpoints: manifestless.length,
              incompatible_manifest_count: incompatibleCount,
              diff_truncated: diff.truncated,
              // Window-overlap downgrades. Weak lines counted
              // under ambiguous_lines above; provisional lines remain
              // attributed but their overlap group has not fully closed.
              overlap_weak_lines: overlapWeak,
              overlap_provisional_lines: provisional,
              // Attributed via cross-file content match only.
              cross_file_lines: crossFileLines,
            },
            note:
              'exact line-content matching only (no fuzzy tracking); unattributed lines may be ' +
              'human-authored, rebased, or outside checkpoint windows — absence of attribution ' +
              'is not authorship evidence either way',
          },
        },
      };
      const emitted = context.config.digest.redact_secrets ? redactSecretsInObject(record) : record;
      const serialized = stringifyTerminalSafeJson(emitted, 2);

      let notesWritten = false;
      if (opts.notes === true) {
        await repo.addNote(AGENT_TRACE_NOTES_REF, commitSha, JSON.stringify(emitted));
        notesWritten = true;
      }

      if (opts.out !== undefined && opts.out.length > 0) {
        const outPath = path.resolve(opts.out);
        await mkdir(path.dirname(outPath), { recursive: true });
        await writeFile(outPath, `${JSON.stringify(emitted)}\n`, { flag: 'a' });
        // Realpath both sides — macOS tempdirs are symlinked (/var →
        // /private/var) and a naive prefix check would miss the repo.
        const repoRootReal = await realpath(git.worktreeRoot).catch(() => git.worktreeRoot);
        const outReal = await realpath(outPath).catch(() => outPath);
        const inRepo = outReal.startsWith(`${repoRootReal}${path.sep}`);
        const inScrubbedDir = outReal.startsWith(
          `${path.join(repoRootReal, '.agent-trace')}${path.sep}`
        );
        if (inRepo && !inScrubbedDir) {
          writeTerminalSafeStderr(
            `[export agent-trace] ${outPath} is inside the repo but outside .agent-trace/ — ` +
              `gitignore it, or use .agent-trace/ (excluded from snapshot trees).\n`
          );
        }
        if (opts.json) {
          emitOk({ commit: commitSha, out: outPath, notes_written: notesWritten });
          return;
        }
        writeTerminalSafeStderr(`Appended agent-trace record to ${outPath}\n`);
        return;
      }

      if (opts.json) {
        emitOk({
          commit: commitSha,
          notes_written: notesWritten,
          ...(notesWritten ? { notes_ref: AGENT_TRACE_NOTES_REF } : {}),
          record: emitted,
        });
        return;
      }
      process.stdout.write(`${serialized}\n`);
      if (notesWritten) {
        writeTerminalSafeStderr(
          `Note attached at ${AGENT_TRACE_NOTES_REF} (local only — push deliberately with ` +
            `\`git push origin ${AGENT_TRACE_NOTES_REF}\`).\n`
        );
      }
    } catch (cause) {
      closeFailedHistoryRead(context.scope);
      throw cause;
    } finally {
      context.scope.close();
    }
  } catch (cause) {
    const err = historyScopeCommandError(cause);
    if (opts.json) emitError(err);
    writeErrorLine(err);
    throw new CliExit(1);
  }
}

export { parseAddedLines, toRanges, type AddedLine } from '../lib/history-trace-views.js';
