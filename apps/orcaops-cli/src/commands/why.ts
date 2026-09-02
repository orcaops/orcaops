import { access, readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  lineContentMatch,
  type ManifestSource,
  resolveWhy,
  resolveWhyFile,
  type WhyMatch,
} from '@orcaops/core';
import { DiffFingerprintManifestSchema, redactSecretsInObject } from '@orcaops/storage';

import { ErrorCodes, OrcaopsError } from '../io/errors.js';
import { CliExit } from '../io/exit.js';
import { emitError, emitOk, writeErrorLine, writeTerminalSafeStdout } from '../io/output.js';
import { buildContext, type CliContext } from '../lib/context.js';
import { readDerivedCache } from '../lib/fingerprint-cache.js';
import { getInvocationCwd, getInvocationEnv } from '../lib/invocation-context.js';
import { classifyOverlapMatch } from '../lib/manifest-sources.js';
import { toRepoRelative } from '../lib/resolve-root.js';
import { readSeedDiscoveryAreas } from './seed/journal.js';
import { parseDigitInt } from '../lib/strict-int.js';

export interface WhyOptions {
  all?: boolean;
  branch?: string;
  json?: boolean;
}

// Shown on a no-match. Conditional by design — `why` can't know whether
// the file was segment-attributed (that needs a manifest index it doesn't
// have), so the wording says "may still be" and points at the
// authoritative attribution surfaces. Never wrong.
const SEGMENT_ATTRIBUTION_HINT =
  "not claimed in any checkpoint's files_changed; if it changed during a " +
  'concurrent checkpoint window it may still be segment-attributed — check ' +
  '`orcaops diff --attribution` or the digest';

/**
 * The generic miss hint speaks in live-capture terms (files_changed,
 * concurrent windows, segment attribution). When the target is not a file
 * at all — a symbol name queried directly — and the store holds ONLY
 * imported artifacts, that framing is misleading: no symbol lane exists
 * over imports, and imported artifacts resolve by file:line. One
 * existence probe + one row listing, on a miss only.
 */
async function missBaseHint(ctx: CliContext, repoRelFile: string): Promise<string> {
  try {
    await access(path.join(ctx.repoRoot, repoRelFile));
    return SEGMENT_ATTRIBUTION_HINT;
  } catch {
    // fall through: the target is not a worktree file
  }
  const rows = ctx.store.store.listArtifacts();
  const imported = rows.filter((row) => row.origin_kind === 'git-import').length;
  if (imported === 0 || imported !== rows.length) return SEGMENT_ATTRIBUTION_HINT;
  return (
    `"${repoRelFile}" is not a file in the worktree; the symbol lane has no ` +
    'imported coverage — imported artifacts resolve by file:line. Locate the ' +
    "symbol's definition and re-run `orcaops why <file>:<line>`"
  );
}

function seedCommitHint(blameSha: string): string {
  return (
    `this line's history isn't imported; ` +
    `\`orcaops seed --commit ${blameSha}\` will import its cluster`
  );
}

function declinedAreaHint(area: string): string {
  return (
    `this line's history isn't imported; imports for ${area} were declined — ` +
    `re-enable with \`orcaops seed status --offer-again ${area}\``
  );
}

function weakSeedCommitHint(blameSha: string): string {
  return (
    `weak match only — the authoring cluster isn't imported; ` +
    `\`orcaops seed --commit ${blameSha}\` will import it`
  );
}

function weakDeclinedAreaHint(area: string): string {
  return (
    `weak match only — the authoring cluster isn't imported; imports for ${area} ` +
    `were declined — re-enable with \`orcaops seed status --offer-again ${area}\``
  );
}

/**
 * Neither hint may push `seed --commit` at an area the user declined.
 * One precious-file read, only on a miss or weak match; any read failure
 * keeps the plain import hint — the hint stays cheap and read-only.
 */
async function declinedAreaFor(ctx: CliContext, repoRelFile: string): Promise<string | null> {
  try {
    const areas = await readSeedDiscoveryAreas(ctx.repo, getInvocationEnv());
    for (const [area, state] of Object.entries(areas)) {
      if (!state.declined_at) continue;
      if (repoRelFile === area || repoRelFile.startsWith(`${area}/`)) {
        return area;
      }
    }
  } catch {
    // fall through to the plain import hint
  }
  return null;
}

async function seedMissHint(
  ctx: CliContext,
  repoRelFile: string,
  blameSha: string
): Promise<string> {
  const area = await declinedAreaFor(ctx, repoRelFile);
  return area === null ? seedCommitHint(blameSha) : declinedAreaHint(area);
}

/**
 * A weak match is file-overlap-grade evidence, not authorship — when the
 * blame commit's cluster is not imported, the discovery door must stay
 * open beside it. One coverage lookup (checkpoint-head index) plus the
 * shared precious-file read.
 */
async function seedWeakMatchHint(
  ctx: CliContext,
  repoRelFile: string,
  blameSha: string
): Promise<string | null> {
  if (ctx.store.store.hasImportedCommitCoverage(blameSha)) return null;
  const area = await declinedAreaFor(ctx, repoRelFile);
  return area === null ? weakSeedCommitHint(blameSha) : weakDeclinedAreaHint(area);
}

/**
 * `orcaops why <file>:<line>` — explain when/why a line was last touched
 * by walking git blame → captured artifacts.
 */
export async function whyAction(target: string, opts: WhyOptions = {}): Promise<void> {
  try {
    const { file, line } = parseTarget(target);

    const ctx = await buildContext({ mintArchiveIdentity: false });
    try {
      // The target is interpreted cwd-relative (or absolute) — the shell
      // convention — then mapped to the repo-root-relative form stored in
      // files_changed, so `why` resolves from any subdirectory.
      const repoRelFile = await toRepoRelative(ctx.repoRoot, getInvocationCwd(), file);
      const rawResult =
        line === null
          ? await resolveWhyFile({
              repo: ctx.repo,
              store: ctx.store.store,
              file: repoRelFile,
              branch: opts.branch,
              // Surface window-overlap ambiguity on whole-file matches too,
              // reusing the same adjudication probe the line path is given.
              overlapStatusProbe: buildOverlapStatusProbe(ctx, repoRelFile),
              degradedStatusProbe: buildDegradedStatusProbe(ctx, repoRelFile),
            })
          : await resolveWhy({
              repo: ctx.repo,
              store: ctx.store.store,
              file: repoRelFile,
              line,
              branch: opts.branch,
              lineContentProbe: await buildLineContentProbe(ctx, repoRelFile, line),
              overlapStatusProbe: buildOverlapStatusProbe(ctx, repoRelFile),
              degradedStatusProbe: buildDegradedStatusProbe(ctx, repoRelFile),
            });
      // Output-time redaction: tasks, checkpoint summaries, and
      // match reasons can quote agent narrative that included a
      // pasted secret. Governed by the same `digest.redact_secrets`
      // knob that gates digest / resume / search output.
      const result = ctx.config.digest.redact_secrets
        ? redactSecretsInObject(rawResult)
        : rawResult;

      const missHint =
        result.best === null && result.blame_sha !== null
          ? await seedMissHint(ctx, repoRelFile, result.blame_sha)
          : null;
      const baseHint =
        result.best === null ? await missBaseHint(ctx, repoRelFile) : SEGMENT_ATTRIBUTION_HINT;
      const weakHint =
        result.best !== null && result.best.confidence === 'weak' && result.blame_sha !== null
          ? await seedWeakMatchHint(ctx, repoRelFile, result.blame_sha)
          : null;
      if (opts.json) {
        emitOk({
          file: repoRelFile,
          line,
          // Additive: `confidence` alone cannot express that whole-file mode
          // is an aggregate rather than a weak attribution, and every reader
          // parsing confidence predates this field.
          mode: line === null ? ('whole-file' as const) : ('line' as const),
          blame_sha: result.blame_sha,
          best: result.best,
          all: line === null || opts.all ? result.all : undefined,
          // When nothing claimed the file in files_changed, hint that a
          // concurrent-window change may still be segment-attributed elsewhere.
          ...(result.best === null
            ? {
                hint: missHint === null ? baseHint : `${baseHint}; ${missHint}`,
              }
            : weakHint !== null
              ? { hint: weakHint }
              : {}),
        });
        return;
      }

      writeTerminalSafeStdout(
        formatHuman(repoRelFile, line, result, opts.all === true, missHint, weakHint, baseHint)
      );
    } finally {
      ctx.store.close();
    }
  } catch (err) {
    if (opts.json) emitError(err);
    writeErrorLine(err);
    throw new CliExit(1);
  }
}

/**
 * Build the line-membership probe: read the target line's
 * CURRENT content from the worktree, then answer per-(artifact, cp)
 * manifest membership (stored manifest → archive derive-cache). Returns
 * undefined when the line content is unreadable (deleted file,
 * out-of-range line) — the resolver then runs pure-ancestry, unchanged.
 * Trivial lines and unreadable manifests answer null (never demotes).
 */
/**
 * Overlap adjudication probe for `resolveWhy` — classifies
 * the queried file against each candidate checkpoint's folded overlap
 * sets (ambiguous / mixed_segment → weak downgrade; own_claim_pending →
 * provisional reason). Adjudications are memoized per artifact; the
 * common no-overlap artifact costs one cheap lookup that returns an
 * empty map.
 */
function buildOverlapStatusProbe(
  ctx: CliContext,
  repoRelFile: string
): (
  artifactId: string,
  n: number
) => Promise<'ambiguous' | 'mixed_segment' | 'own_claim_pending' | null> {
  const memo = new Map<string, Awaited<ReturnType<typeof ctx.store.adjudicateWindowOverlap>>>();
  return async (artifactId, n) => {
    let adjudications = memo.get(artifactId);
    if (adjudications === undefined) {
      // No catch: `why` is a provenance RESOLUTION surface, and this
      // probe runs for every matched checkpoint. A recovery refusal from
      // the matched artifact must refuse the answer — converting it to
      // an empty map would serve a CLEANER attribution (no downgrade)
      // from an artifact whose event log cannot be read.
      adjudications = await ctx.store.adjudicateWindowOverlap(artifactId);
      memo.set(artifactId, adjudications);
    }
    return classifyOverlapMatch(adjudications.get(n), repoRelFile);
  };
}

/**
 * Unmerged-degradation probe for `resolveWhy` / `resolveWhyFile`:
 * classifies the queried file against the matched checkpoint's
 * `attribution_degraded` record — `'unmerged'` when the path list names
 * the file, `'probe_failed'` when the record marks the window unverified
 * (file-specific wins when both hold). Memoized per (artifact, n).
 *
 * No catch — same doctrine as `buildOverlapStatusProbe` above: a read
 * failure from the matched checkpoint must refuse the answer; converting
 * it to null would serve a CLEANER attribution from a record that cannot
 * be read.
 */
function buildDegradedStatusProbe(
  ctx: CliContext,
  repoRelFile: string
): (artifactId: string, n: number) => Promise<'unmerged' | 'probe_failed' | null> {
  const memo = new Map<string, 'unmerged' | 'probe_failed' | null>();
  return async (artifactId, n) => {
    const key = `${artifactId}:${n}`;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    let verdict: 'unmerged' | 'probe_failed' | null = null;
    const cp = await ctx.store.readCheckpoint(artifactId, n);
    if (cp?.status === 'closed' && cp.attribution_degraded !== undefined) {
      if (cp.attribution_degraded.unmerged_paths.includes(repoRelFile)) {
        verdict = 'unmerged';
      } else if (cp.attribution_degraded.probe_failed === true) {
        verdict = 'probe_failed';
      }
    }
    memo.set(key, verdict);
    return verdict;
  };
}

async function buildLineContentProbe(
  ctx: CliContext,
  repoRelFile: string,
  line: number
): Promise<
  | ((
      artifactId: string,
      n: number
    ) => Promise<{ matched: boolean; manifest_files: string[] } | null>)
  | undefined
> {
  let lineText: string;
  try {
    const content = await readFile(path.join(ctx.repoRoot, repoRelFile), 'utf8');
    const rows = content.split('\n');
    if (line > rows.length) return undefined;
    lineText = rows[line - 1];
  } catch {
    return undefined;
  }
  const memo = new Map<string, { matched: boolean; manifest_files: string[] } | null>();
  return async (artifactId, n) => {
    const key = `${artifactId}:${n}`;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    let verdict: { matched: boolean; manifest_files: string[] } | null = null;
    // No catch: the fingerprint reader and derive-cache both return null
    // for missing/corrupt manifests, so anything thrown here is an
    // fs/containment/programming error — swallowing it would leave an
    // ancestry confidence standing that a real mismatch would withhold.
    {
      let manifest = await ctx.store.readCheckpointDiffFingerprint(artifactId, n);
      if (manifest === null && ctx.archive !== null) {
        const derived = await readDerivedCache(ctx.archive.projectDir, artifactId, n);
        if (derived !== null) {
          const parsed = DiffFingerprintManifestSchema.safeParse(derived.manifest);
          manifest = parsed.success ? parsed.data : null;
        }
      }
      if (manifest !== null) {
        const source: ManifestSource = {
          artifact_id: artifactId,
          checkpoint_n: n,
          ts: '',
          manifest,
        };
        const match = await lineContentMatch([source], lineText);
        // Surface WHICH files carried the hash so the
        // resolver can distinguish same-file from cross-file matches.
        verdict = match.trivial
          ? null
          : {
              matched: match.matches.length > 0,
              manifest_files: match.matches[0]?.manifest_files ?? [],
            };
      }
    }
    memo.set(key, verdict);
    return verdict;
  };
}

export function parseTarget(target: string): { file: string; line: number | null } {
  const idx = target.lastIndexOf(':');
  // Whole-file mode: no `:line` suffix aggregates every
  // checkpoint that claimed the file (line: null).
  if (idx === -1) {
    if (target.length === 0) {
      throw new OrcaopsError(ErrorCodes.INVALID_INPUT, '<file> cannot be empty.', 'file');
    }
    return { file: target, line: null };
  }
  const file = target.slice(0, idx);
  const lineStr = target.slice(idx + 1);
  const line = parseDigitInt(lineStr) ?? NaN;
  if (!Number.isInteger(line) || line < 1) {
    throw new OrcaopsError(
      ErrorCodes.INVALID_INPUT,
      `<line> must be a positive integer; got "${lineStr}".`,
      'line'
    );
  }
  if (file.length === 0) {
    throw new OrcaopsError(ErrorCodes.INVALID_INPUT, '<file> cannot be empty.', 'file');
  }
  return { file, line };
}

function formatHuman(
  file: string,
  line: number | null,
  result: { best: WhyMatch | null; all: WhyMatch[]; blame_sha: string | null },
  showAll: boolean,
  missHint: string | null,
  weakHint: string | null = null,
  baseHint: string = SEGMENT_ATTRIBUTION_HINT
): string {
  const lines: string[] = [];
  lines.push(line === null ? `why ${file} (whole-file)` : `why ${file}:${line}`);
  lines.push('');
  if (line === null) {
    lines.push(wholeFileHeading(result.all.length));
  } else if (result.blame_sha) {
    lines.push(`Blame commit: ${result.blame_sha.slice(0, 8)}`);
  } else {
    lines.push('Blame commit: <unblamable — line is uncommitted or file is outside the repo>');
  }
  lines.push('');

  if (!result.best) {
    lines.push('No matching captured artifact.');
    if (result.blame_sha) {
      lines.push(
        '(The line was committed, but no orcaops checkpoint touched this file. Most likely the line predates orcaops capture on this branch.)'
      );
    }
    // Conditional segment-attribution hint (never wrong; see const above) —
    // or the symbol-lane hint when the target is not a file on an
    // imported-only store.
    lines.push(`(${baseHint})`);
    if (missHint) lines.push(`(${missHint})`);
    lines.push('');
    return lines.join('\n');
  }

  // Plan decisions are sliced AS-OF the revision each checkpoint opened against,
  // so two checkpoints of one artifact at DIFFERENT open revisions show
  // different slices. Dedup per (artifact, open-revision) — render each distinct
  // slice once — rather than per artifact. Checkpoint decisions stay per-match.
  const planDecisionsShown = new Set<string>();
  const showPlan = (m: WhyMatch): boolean => {
    const key = `${m.artifact_id} ${m.open_plan_revision_event_id}`;
    if (planDecisionsShown.has(key)) return false;
    planDecisionsShown.add(key);
    return true;
  };

  const wholeFile = line === null;
  if (wholeFile && !showAll) {
    lines.push(renderWholeFileCompactHistory(result.all));
    lines.push('');
    return lines.join('\n');
  }

  lines.push(renderMatch(result.best, true, showPlan(result.best), wholeFile));
  lines.push('');
  if (weakHint) {
    lines.push(`(${weakHint})`);
    lines.push('');
  }

  if (showAll && result.all.length > 1) {
    if (!wholeFile) {
      lines.push(`Other candidates (${result.all.length - 1}):`);
      lines.push('');
    }
    for (const m of result.all.slice(1)) {
      lines.push(renderMatch(m, false, showPlan(m), wholeFile));
      lines.push('');
    }
  } else if (!showAll && result.all.length > 1) {
    const rest = result.all.length - 1;
    lines.push(`(${rest} more candidate${rest === 1 ? '' : 's'} — pass --all to see them)`);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Multi-line tasks (imported artifacts embed the full commit list) would
 * dump hundreds of lines into a match rendering; collapse to the first
 * line plus a commit count. The full text stays in the artifact.
 */
function renderTask(task: string): string {
  const [first = '', ...rest] = task.split('\n');
  if (rest.length === 0) return first;
  const commits = rest.filter((line) => /^-\s+[0-9a-f]{7}\b/u.test(line.trim())).length;
  return commits > 0
    ? `${first.trim()} … (${commits} commit${commits === 1 ? '' : 's'})`
    : `${first.trim()} …`;
}

/**
 * Whole-file mode is a list, not a ranking: say how long it is and that it is
 * ordered, so a reader does not mistake the first entry for an authorship
 * claim about the file.
 */
function wholeFileHeading(count: number): string {
  if (count === 0) return 'Whole-file mode: no checkpoint claimed this file.';
  return `Whole-file mode: ${count} checkpoint${count === 1 ? '' : 's'} claimed this file, newest first. This lists what touched the file — for why a particular line is the way it is, pass \`<file>:<line>\`.`;
}

const WHOLE_FILE_SUMMARY_MAX_CHARS = 120;

function singleLineExcerpt(value: string, maxChars: number): string {
  const singleLine = value.replace(/\s+/gu, ' ').trim();
  if (singleLine.length <= maxChars) return singleLine;
  return `${singleLine.slice(0, maxChars - 1).trimEnd()}…`;
}

export function wholeFileMarkers(m: Pick<WhyMatch, 'origin' | 'overlap' | 'degraded'>): string[] {
  const markers: string[] = [];
  if (m.origin?.kind === 'git-import') markers.push('[origin:git-import]');
  if (m.overlap !== undefined) markers.push(`[overlap:${m.overlap}]`);
  if (m.degraded !== undefined) markers.push(`[degraded:${m.degraded}]`);
  return markers;
}

export function renderWholeFileCompactRecord(m: WhyMatch): string {
  const timestamp = m.ts.replace(/\.\d+Z$/u, 'Z');
  const markers = wholeFileMarkers(m);
  const fields = [
    timestamp,
    m.checkpoint_head_sha.slice(0, 8),
    `#${m.checkpoint_n}`,
    `[${m.branch}]`,
    singleLineExcerpt(m.checkpoint_summary, WHOLE_FILE_SUMMARY_MAX_CHARS),
    ...markers,
    `artifact=${m.artifact_id}`,
  ];
  return fields.join(' ');
}

export function renderWholeFileCompactHistory(matches: WhyMatch[]): string {
  return matches.map(renderWholeFileCompactRecord).join('\n');
}

function renderMatch(
  m: WhyMatch,
  primary: boolean,
  renderPlanDecisions: boolean,
  wholeFile = false
): string {
  const lines: string[] = [];
  // Whole-file mode aggregates rather than attributes, so it has no best
  // match to crown and no tier to report: every entry is equally a
  // checkpoint that claimed the file. Borrowing line mode's vocabulary made
  // a complete answer read as a failed one.
  const heading = wholeFile ? '--' : primary ? '** best match **' : '--';
  lines.push(heading);
  lines.push(`  artifact:   ${m.artifact_id}  (branch: ${m.branch})`);
  if (m.origin?.kind === 'git-import') {
    lines.push('  origin:     imported from git history (synthesized)');
  }
  lines.push(`  task:       ${renderTask(m.task)}`);
  lines.push(`  checkpoint: #${m.checkpoint_n} — ${m.checkpoint_summary}`);
  lines.push(`  cp head:    ${m.checkpoint_head_sha.slice(0, 8)}  @ ${m.ts}`);
  if (!wholeFile) {
    lines.push(`  confidence: ${m.confidence}${m.cross_file ? ' (cross-file)' : ''} — ${m.reason}`);
  } else {
    const markers = wholeFileMarkers(m);
    if (markers.length > 0) lines.push(`  qualifiers: ${markers.join(' ')}`);
    lines.push(`  context:    ${m.reason}`);
  }
  // Captured decision provenance: the WHY behind this
  // file — plan-time decisions on the artifact, then the matched cp's. Renders
  // nothing when none were captured (clean empty case, no "cp undefined"). The
  // rejected alternatives are the load-bearing provenance, so render them.
  const renderAlts = (alts?: Array<{ option: string; rejected_because: string }>) => {
    if (!alts || alts.length === 0) return;
    for (const alt of alts) {
      lines.push(`    - considered ${alt.option} — rejected because ${alt.rejected_because}`);
    }
  };
  if (renderPlanDecisions) {
    for (const dec of m.plan_decisions) {
      lines.push(`  decision (plan rev ${dec.revision_n}): ${dec.decision} — ${dec.reason}`);
      renderAlts(dec.alternatives_considered);
    }
  }
  for (const dec of m.checkpoint_decisions) {
    lines.push(`  decision (cp ${m.checkpoint_n}): ${dec.decision} — ${dec.reason}`);
    renderAlts(dec.alternatives_considered);
  }
  return lines.join('\n');
}
