import { isValidGlobSyntax, matchesAnyGlob } from '@orcaops/evaluator-protocol';
import {
  isSearchType,
  SEARCH_TYPES,
  type SearchType,
} from '@orcaops/evaluator-protocol/search-types';
import { redactSecretsInString, type SearchResultRow } from '@orcaops/storage';

import { parseLimit } from './list.js';
import { ErrorCodes, OrcaopsError } from '../io/errors.js';
import { CliExit } from '../io/exit.js';
import { emitError, emitOk, writeErrorLine, writeTerminalSafeStdout } from '../io/output.js';
import {
  type SelectedArtifactProjection,
  selectProjectArtifacts,
} from '../lib/artifact-projections.js';
import { importedTag } from '../lib/artifact-scope.js';
import { buildContext } from '../lib/context.js';
import { readForEnumeration } from '../lib/enumeration-read.js';
import { formatProjectScopeWarnings, openAllProjects } from '../lib/project-scope.js';

/**
 * Re-exported from the shared contract rather than declared here, so the
 * test harness that drives this command cannot fall behind it — which is
 * exactly what happened: the harness modelled four of these seven.
 */
export type { SearchType };

export interface SearchOptions {
  branch?: string;
  type?: string;
  limit?: number;
  /**
   * Glob over the artifact's touched surface: a result row survives iff its
   * artifact's scope-path set (closed cps' `files_changed` ∪ the latest plan
   * revision's `touched_scope` entries as literal paths) matches. `--limit`
   * applies AFTER this filter.
   */
  scope?: string;
  /**
   * Cross-project mode: fan the FTS query over every archived project's
   * index. The current project's hot and retained archive hits are
   * deduplicated freshest-first, with ties using hot, before the merged
   * results are ordered newest-first and re-limited. Implies all branches
   * (rejects `--branch`). `--scope` applies per project (paths are repo-local).
   */
  allProjects?: boolean;
  imported?: boolean;
  json?: boolean;
}

/**
 * Pre-filter fetch cap when `--scope` is active. `Store.search` defaults
 * `limit ?? 25` — passing undefined does NOT mean unlimited, and a 25-row
 * pre-filter fetch would silently scope-filter only the top FTS matches.
 * Cost acceptance: 10k rows is effectively "all matches" at OSS per-repo
 * scale, and the scope pass is one memoized closed-cps + plan read per
 * DISTINCT artifact in the result set.
 */
export const SCOPE_PREFILTER_LIMIT = 10_000;

/** Store default when `--limit` is omitted (mirrored from `Store.search`). */
const DEFAULT_RESULT_LIMIT = 25;

/**
 * `orcaops search <query>` — FTS5 search over plan / checkpoint /
 * summary / evaluator / digest / block-resolution / pin-displaced
 * content. Index-time + output-time redaction keeps
 * secret values out of every layer.
 */
export async function searchAction(query: string, opts: SearchOptions = {}): Promise<void> {
  try {
    if (!query || query.trim().length === 0) {
      throw new OrcaopsError(ErrorCodes.INVALID_INPUT, '<query> cannot be empty.', 'query');
    }
    parseLimit(opts.limit);
    let typeFilter: SearchType | undefined;
    if (opts.type !== undefined) {
      if (!isSearchType(opts.type)) {
        throw new OrcaopsError(
          ErrorCodes.INVALID_INPUT,
          `--type must be one of: ${SEARCH_TYPES.join(', ')}; got "${opts.type}".`,
          'type'
        );
      }
      typeFilter = opts.type as SearchType;
    }

    const scopeGlob = opts.scope;
    if (scopeGlob !== undefined && (scopeGlob.trim() === '' || !isValidGlobSyntax(scopeGlob))) {
      throw new OrcaopsError(
        ErrorCodes.INVALID_INPUT,
        `--scope must be a valid glob pattern; got "${scopeGlob}".`,
        'scope'
      );
    }

    if (opts.allProjects) {
      if (opts.branch !== undefined) {
        throw new OrcaopsError(
          ErrorCodes.INVALID_INPUT,
          '--all-projects implies all branches; drop --branch.',
          'branch'
        );
      }
      await runSearchAllProjects(query, opts, typeFilter, scopeGlob);
      return;
    }

    const ctx = await buildContext({ mintArchiveIdentity: false });
    try {
      const rows: SearchResultRow[] = ctx.store.store.search(sanitizeFtsQuery(query), {
        branch: opts.branch,
        sourcePrefix: typeFilter,
        // With --scope the filter must see (effectively) ALL matches, then
        // --limit applies post-filter — otherwise scoped rows below the
        // store's 25-row default cutoff would be silently dropped.
        limit: scopeGlob === undefined ? opts.limit : SCOPE_PREFILTER_LIMIT,
        includeImported: opts.imported !== false,
      });
      // Disclosure for pre-filter truncation: exactly cap-many rows means
      // the fetch MAY have been cut.
      const prefilterTruncated = scopeGlob !== undefined && rows.length >= SCOPE_PREFILTER_LIMIT;
      let scopedRows = rows;
      const degradedScopeArtifacts: string[] = [];
      if (scopeGlob !== undefined) {
        const scopePathsByArtifact = new Map<string, readonly string[]>();
        for (const r of rows) {
          if (scopePathsByArtifact.has(r.artifact_id)) continue;
          const paths: string[] = [];
          for (const cp of ctx.store.store.getClosedCheckpoints(r.artifact_id)) {
            paths.push(...cp.files_changed);
          }
          const planRead = await readForEnumeration(r.artifact_id, 'search --scope', () =>
            ctx.store.readPlan(r.artifact_id)
          );
          if (planRead.kind === 'unreadable') {
            // touched_scope is unknown: the filter can still match on
            // checkpoint paths (true positives), but a miss is
            // inconclusive — disclose the artifact instead of dropping
            // its hits silently.
            degradedScopeArtifacts.push(r.artifact_id);
          } else {
            paths.push(...(planRead.value?.touched_scope ?? []));
          }
          scopePathsByArtifact.set(r.artifact_id, paths);
        }
        scopedRows = filterResultsByScope(rows, scopePathsByArtifact, scopeGlob).slice(
          0,
          opts.limit ?? DEFAULT_RESULT_LIMIT
        );
      }
      // Output-time snippet redaction. Indexing also redacts, but defense
      // in depth catches any unredacted rows
      // that survived a `rebuild`. Cheap and idempotent on clean text.
      const redactedRows = ctx.config.digest.redact_secrets
        ? scopedRows.map((r) => ({ ...r, snippet: redactSecretsInString(r.snippet) }))
        : scopedRows;

      // One health probe per DISTINCT artifact in the emitted rows: the
      // FTS index serves snippets regardless of log health, so a hit
      // from an unreadable artifact must carry the marker rather than
      // read as a verified fact.
      const unreadableHitArtifacts = new Set<string>();
      for (const id of new Set(redactedRows.map((r) => r.artifact_id))) {
        const probe = await readForEnumeration(id, 'search', () => ctx.store.readArtifact(id));
        if (probe.kind === 'unreadable') unreadableHitArtifacts.add(id);
      }
      const degradedArtifacts = [...unreadableHitArtifacts].sort();

      if (opts.json) {
        emitOk({
          query,
          branch: opts.branch ?? null,
          type: typeFilter ?? null,
          scope: scopeGlob ?? null,
          count: redactedRows.length,
          ...(prefilterTruncated ? { prefilter_truncated: true } : {}),
          degraded_scope_artifacts: degradedScopeArtifacts,
          degraded_artifacts: degradedArtifacts,
          results: redactedRows.map((r) => ({
            ...toResultPayload(r),
            ...(unreadableHitArtifacts.has(r.artifact_id) ? { unreadable: true as const } : {}),
          })),
        });
        return;
      }

      writeTerminalSafeStdout(
        formatHuman(
          query,
          redactedRows,
          prefilterTruncated,
          degradedScopeArtifacts,
          degradedArtifacts
        )
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
 * Cross-project fan-out. Each project's store answers the same query
 * (rank is not comparable across FTS indexes, so the merge orders by
 * `ts` — deterministic and meaningful); `--limit` applies to the merged
 * set. Scope paths are read from the STORE (closed-cp files_changed ∪
 * latest plan revision's touched_scope), which works identically for
 * the hot store and archive indexes.
 */
async function runSearchAllProjects(
  query: string,
  opts: SearchOptions,
  typeFilter: SearchType | undefined,
  scopeGlob: string | undefined
): Promise<void> {
  const scope = await openAllProjects();
  try {
    let prefilterTruncated = false;
    const warnings = [...scope.issues];
    const malformedScopeArtifacts = new Set<string>();
    const selectedByPair = new Map<string, SelectedArtifactProjection>();
    const merged: Array<SearchResultPayload & { project_id: string; project: string }> = [];
    for (const p of scope.projects) {
      const selected = await selectProjectArtifacts(p);
      const selectedById = new Map(selected.map((artifact) => [artifact.row.id, artifact]));
      const selectedSources = new Map(
        selected.map((artifact) => [artifact.row.id, artifact.source])
      );
      for (const artifact of selected) {
        selectedByPair.set(`${p.projectId}:${artifact.row.id}`, artifact);
      }
      const querySources =
        p.hotStore === undefined
          ? [{ source: 'archive' as const, store: p.store }]
          : [
              { source: 'hot' as const, store: p.store },
              ...(p.archiveStore ? [{ source: 'archive' as const, store: p.archiveStore }] : []),
            ];
      for (const querySource of querySources) {
        // The cap is observed on every raw source query before stale
        // projection hits are discarded.
        const rawRows = querySource.store.search(sanitizeFtsQuery(query), {
          sourcePrefix: typeFilter,
          limit: SCOPE_PREFILTER_LIMIT,
          includeImported: opts.imported !== false,
        });
        const selectedHits = selectSearchProjectionHits(
          rawRows,
          selectedSources,
          querySource.source
        );
        if (selectedHits.prefilterTruncated) prefilterTruncated = true;
        const rows = selectedHits.rows;
        let scoped = rows;
        if (scopeGlob !== undefined) {
          const scopePathsByArtifact = new Map<string, readonly string[]>();
          for (const r of rows) {
            if (scopePathsByArtifact.has(r.artifact_id)) continue;
            const artifact = selectedById.get(r.artifact_id)!;
            const paths: string[] = [];
            for (const cp of artifact.store.getClosedCheckpoints(r.artifact_id)) {
              paths.push(...cp.files_changed);
            }
            const revN = artifact.store.latestPlanRevisionN(r.artifact_id);
            if (revN >= 0) {
              const rev = artifact.store.getPlanRevision(r.artifact_id, revN);
              if (rev) {
                try {
                  const touchedScope: unknown = JSON.parse(rev.plan.touched_scope);
                  if (
                    !Array.isArray(touchedScope) ||
                    !touchedScope.every((entry): entry is string => typeof entry === 'string')
                  ) {
                    throw new TypeError('touched_scope is not a string array');
                  }
                  paths.push(...touchedScope);
                } catch {
                  const key = `${p.projectId}:${r.artifact_id}`;
                  if (!malformedScopeArtifacts.has(key)) {
                    malformedScopeArtifacts.add(key);
                    warnings.push({
                      kind: 'project_index_degraded',
                      project_id: p.projectId,
                      project: p.displayName,
                      message:
                        `Artifact ${r.artifact_id} has malformed touched_scope; ` +
                        'scope-filtered results may be incomplete.',
                    });
                  }
                }
              }
            }
            scopePathsByArtifact.set(r.artifact_id, paths);
          }
          scoped = filterResultsByScope(rows, scopePathsByArtifact, scopeGlob);
        }
        merged.push(
          ...scoped.map((r) => ({
            ...toResultPayload(r),
            project_id: p.projectId,
            project: p.displayName,
          }))
        );
      }
    }
    merged.sort(
      (a, b) =>
        (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0) ||
        Number(a.origin === 'git-import') - Number(b.origin === 'git-import')
    );
    const limited = merged.slice(0, opts.limit ?? DEFAULT_RESULT_LIMIT);
    const redacted = limited.map((r) => ({ ...r, snippet: redactSecretsInString(r.snippet) }));

    // Same health probe the single-project arm runs, but only when the
    // selected source is hot. Archive-selected hits are covered by index
    // quarantine and never fall back to their hot twin.
    const unreadableHits = new Set<string>();
    const probedPairs = new Set<string>();
    const hotByProjectId = new Map(
      scope.projects.flatMap((p) =>
        p.hotStore === undefined ? [] : ([[p.projectId, p.hotStore]] as const)
      )
    );
    for (const r of limited) {
      const key = `${r.project_id}:${r.artifact_id}`;
      if (probedPairs.has(key)) continue;
      probedPairs.add(key);
      const selected = selectedByPair.get(key);
      if (selected?.source !== 'hot') continue;
      if (selected.hotReadError !== undefined) {
        await readForEnumeration(r.artifact_id, 'search --all-projects', () =>
          Promise.reject(selected.hotReadError)
        );
        unreadableHits.add(key);
        continue;
      }
      const hot = hotByProjectId.get(r.project_id);
      if (hot === undefined) continue;
      const probe = await readForEnumeration(r.artifact_id, 'search --all-projects', () =>
        hot.readArtifact(r.artifact_id)
      );
      if (probe.kind === 'unreadable') unreadableHits.add(key);
    }
    const degradedArtifacts = [
      ...new Set([...unreadableHits].map((k) => k.slice(k.indexOf(':') + 1))),
    ].sort();
    const marked = redacted.map((r) => ({
      ...r,
      ...(unreadableHits.has(`${r.project_id}:${r.artifact_id}`)
        ? { unreadable: true as const }
        : {}),
    }));

    if (opts.json) {
      emitOk({
        query,
        all_projects: true,
        projects: scope.projects.length,
        type: typeFilter ?? null,
        scope: scopeGlob ?? null,
        count: marked.length,
        ...(prefilterTruncated ? { prefilter_truncated: true } : {}),
        ...(warnings.length > 0 ? { warnings } : {}),
        degraded_artifacts: degradedArtifacts,
        results: marked,
      });
      return;
    }
    const lines: string[] = [];
    lines.push(`search: "${query}" (across ${scope.projects.length} project(s))`);
    lines.push('');
    if (marked.length === 0) {
      lines.push('No matches.');
    } else {
      for (const r of marked) {
        lines.push(
          `  [${r.project}] ${r.artifact_id}${r.unreadable === true ? ' [UNREADABLE]' : ''} ` +
            `${importedTag(r.origin)}[${r.source}] @ ${r.ts}`
        );
        lines.push(`    ${r.snippet}`);
        lines.push('');
      }
    }
    if (degradedArtifacts.length > 0) {
      lines.push(
        `${degradedArtifacts.length} matched artifact(s) are unreadable — snippets are ` +
          `index-derived, unverified: ${degradedArtifacts.join(', ')} — run \`orcaops doctor\``
      );
    }
    if (prefilterTruncated) {
      lines.push(
        `note: a project hit the ${SCOPE_PREFILTER_LIMIT}-row pre-filter cap; results may be incomplete.`
      );
    }
    lines.push('');
    writeTerminalSafeStdout(lines.join('\n') + formatProjectScopeWarnings(warnings));
  } finally {
    scope.close();
  }
}

interface SearchResultPayload {
  artifact_id: string;
  source: string;
  branch: string;
  ts: string;
  snippet: string;
  origin: 'git-import' | null;
}

/** Filter stale-source hits without erasing a cap reached by the raw query. */
export function selectSearchProjectionHits(
  rawRows: readonly SearchResultRow[],
  selectedSources: ReadonlyMap<string, 'hot' | 'archive'>,
  querySource: 'hot' | 'archive',
  cap = SCOPE_PREFILTER_LIMIT
): { rows: SearchResultRow[]; prefilterTruncated: boolean } {
  return {
    rows: rawRows.filter((row) => selectedSources.get(row.artifact_id) === querySource),
    prefilterTruncated: rawRows.length >= cap,
  };
}

function toResultPayload(r: SearchResultRow): SearchResultPayload {
  return {
    artifact_id: r.artifact_id,
    source: r.source,
    branch: r.branch,
    ts: r.ts,
    snippet: r.snippet,
    origin: r.origin_kind ?? null,
  };
}

/**
 * Pure `--scope` post-filter: a result row survives iff its artifact's
 * scope-path set matches the glob. Declared `touched_scope` entries are
 * treated as LITERAL paths — a scope entry that is itself a glob matches
 * only if the `--scope` pattern matches its literal text (glob-vs-glob
 * intersection is not attempted; predictable beats clever). Exported for
 * direct unit testing.
 */
export function filterResultsByScope(
  results: readonly SearchResultRow[],
  scopePathsByArtifact: ReadonlyMap<string, readonly string[]>,
  scopeGlob: string
): SearchResultRow[] {
  return results.filter((r) => {
    const paths = scopePathsByArtifact.get(r.artifact_id) ?? [];
    return paths.some((p) => matchesAnyGlob(p, [scopeGlob]));
  });
}

/**
 * Wrap each whitespace-delimited token in FTS5 phrase quotes so user
 * input like "rate-limit" or "x:y" doesn't get parsed as FTS operators
 * or column names. Tokens are AND-ed (default FTS5 implicit operator).
 *
 * Exported for direct unit testing — production code uses it via
 * `searchAction`.
 */
export function sanitizeFtsQuery(raw: string): string {
  return raw
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .map((t) => '"' + t.replace(/"/g, '""') + '"')
    .join(' ');
}

function formatHuman(
  query: string,
  rows: SearchResultRow[],
  prefilterTruncated = false,
  degradedScope: readonly string[] = [],
  degradedArtifacts: readonly string[] = []
): string {
  const lines: string[] = [];
  lines.push(`search: "${query}"`);
  lines.push('');
  const notes = [
    degradedScope.length > 0
      ? `${degradedScope.length} artifact(s) had an unreadable plan — a scope miss for them ` +
        `is inconclusive: ${degradedScope.join(', ')} — run \`orcaops doctor\``
      : null,
    degradedArtifacts.length > 0
      ? `${degradedArtifacts.length} matched artifact(s) are unreadable — their snippets are ` +
        `index-derived, unverified: ${degradedArtifacts.join(', ')} — run \`orcaops doctor\``
      : null,
  ].filter((n): n is string => n !== null);
  const degradedNote = notes.length > 0 ? notes.join('\n') : null;
  if (rows.length === 0) {
    lines.push('No matches.');
    if (degradedNote !== null) lines.push('', degradedNote);
    lines.push('');
    return lines.join('\n');
  }
  lines.push(`${rows.length} match${rows.length === 1 ? '' : 'es'}:`);
  lines.push('');
  for (const r of rows) {
    lines.push(
      `  ${r.artifact_id} ${importedTag(r.origin_kind)}` + `[${r.source}] (${r.branch}) @ ${r.ts}`
    );
    lines.push(`    ${r.snippet}`);
    lines.push('');
  }
  if (prefilterTruncated) {
    lines.push(
      `note: the ${SCOPE_PREFILTER_LIMIT}-row scope pre-filter cap was hit; results may be incomplete.`
    );
    lines.push('');
  }
  if (degradedNote !== null) lines.push('', degradedNote);
  return lines.join('\n');
}
