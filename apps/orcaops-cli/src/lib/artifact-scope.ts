import type { ArtifactRow } from '@orcaops/storage';

import type { CliContext } from './context.js';
import { ErrorCodes, OrcaopsError } from '../io/errors.js';

/**
 * Validate the raw `--limit` flag value. Exported for direct unit
 * testing — production callers go through the command actions.
 */
export function parseLimit(raw: number | undefined): number | undefined {
  if (raw === undefined) return undefined;
  if (!Number.isInteger(raw) || raw <= 0) {
    throw new OrcaopsError(
      ErrorCodes.INVALID_INPUT,
      '--limit must be a positive integer.',
      'limit'
    );
  }
  return raw;
}

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
const TZ_SUFFIX_RE = /(Z|[+-]\d{2}:?\d{2})$/;

/**
 * Parse one window bound with **UTC semantics pinned**:
 *
 *   - date-only `YYYY-MM-DD` → the given UTC day edge (`T00:00:00.000Z` for
 *     lower bounds, `T23:59:59.999Z` for upper bounds);
 *   - a full ISO-8601 datetime passes through, canonicalized to
 *     `Date.toISOString()` Z-form so lexicographic SQL compares against the
 *     stored `toISOString()` timestamps are exact — a datetime WITHOUT an
 *     explicit offset is read as UTC (never local time);
 *   - anything unparseable → `INVALID_INPUT` carrying the flag name.
 *
 * Shared by all four window flags (`--since`/`--until`/`--active-since`/
 * `--active-until`). Exported via {@link parseSince}/{@link parseUntil} for
 * direct unit testing.
 */
function parseWindowBound(
  raw: string | undefined,
  flag: string,
  dayEdge: 'T00:00:00.000Z' | 'T23:59:59.999Z'
): string | undefined {
  if (raw === undefined) return undefined;
  const fail = (): OrcaopsError =>
    new OrcaopsError(
      ErrorCodes.INVALID_INPUT,
      `--${flag} must be an ISO-8601 date (YYYY-MM-DD) or datetime, interpreted as UTC; got "${raw}".`,
      flag
    );
  // Gate on ISO shape BEFORE handing to `new Date`: V8 happily parses
  // non-ISO forms like "07/01/2026" — as LOCAL time — which would silently
  // break the pinned-UTC contract.
  let candidate: string;
  if (DATE_ONLY_RE.test(raw)) {
    candidate = `${raw}${dayEdge}`;
  } else if (/^\d{4}-\d{2}-\d{2}T/.test(raw)) {
    candidate = TZ_SUFFIX_RE.test(raw) ? raw : `${raw}Z`;
  } else {
    throw fail();
  }
  const parsed = new Date(candidate);
  if (Number.isNaN(parsed.getTime())) throw fail();
  // V8 leniently rolls over out-of-range days ("2026-02-30" → Mar 2). For
  // Z-form candidates the UTC date part must round-trip exactly; explicit
  // non-Z offsets legitimately shift the date and are exempt.
  if (candidate.endsWith('Z') && parsed.toISOString().slice(0, 10) !== candidate.slice(0, 10)) {
    throw fail();
  }
  return parsed.toISOString();
}

/** Parse a window LOWER bound (`--since` / `--active-since`). See {@link parseWindowBound}. */
export function parseSince(raw: string | undefined, flag = 'since'): string | undefined {
  return parseWindowBound(raw, flag, 'T00:00:00.000Z');
}

/** Parse a window UPPER bound (`--until` / `--active-until`). See {@link parseWindowBound}. */
export function parseUntil(raw: string | undefined, flag = 'until'): string | undefined {
  return parseWindowBound(raw, flag, 'T23:59:59.999Z');
}

/**
 * Reject an inverted window pair (lower bound after upper bound). Both
 * bounds are already-normalized ISO-Z strings, so string compare is exact.
 */
export function assertWindowOrdered(
  lower: string | undefined,
  upper: string | undefined,
  lowerFlag: string,
  upperFlag: string
): void {
  if (lower !== undefined && upper !== undefined && lower > upper) {
    throw new OrcaopsError(
      ErrorCodes.INVALID_INPUT,
      `--${lowerFlag} (${lower}) must not be after --${upperFlag} (${upper}).`,
      lowerFlag
    );
  }
}

/**
 * Storage-class participation: every read surface that resolves artifacts by
 * branch must decide its seeded-participation explicitly (design rule keyed
 * on the `origin_kind` choke point), so the choice is required, never
 * defaulted.
 *
 * Seeded artifacts record the ref the seed ran against (typically
 * `origin/<branch>`), which never string-matches the local branch name — a
 * branch-scoped default silently excludes the entire imported corpus. Three
 * recorded policies exist:
 *
 * - `'include'`: union `git-import` rows into the branch-scoped DEFAULT
 *   (matching the deliberately cross-branch `list --imported` precedent).
 *   Explicit `--branch` / `--all-branches` scopes are never widened.
 * - `'disclose'`: keep `git-import` rows out of the branch-scoped DEFAULT
 *   (explicit `--branch` / `--all-branches` scopes keep whatever they reach);
 *   the caller OWES the standardized imported trailer (`importedTrailerLine`
 *   / `importedArtifactsDisclosure`) whenever `importedWithheld > 0`.
 * - `'live-only'`: exclude silently — only for live-work resolution where an
 *   imported (always summarized, backdated) artifact can never apply, e.g.
 *   deriving a diff base from in-flight work.
 */
export type SeededReadParticipation = 'include' | 'disclose' | 'live-only';

export interface SeededReadChoice {
  imported: SeededReadParticipation;
}

/** Window bounds accepted by the store listing queries (ISO-Z strings). */
export interface ArtifactScopeWindow {
  since?: string;
  until?: string;
  activeSince?: string;
  activeUntil?: string;
}

export interface BranchReadScope {
  /** Resolved branch scope; undefined = all branches. */
  branch: string | undefined;
  /** True when the scope defaulted to the current branch (no --branch / --all-branches). */
  defaultScope: boolean;
  /** Participation-applied row set — the common consumption path. */
  rows: ArtifactRow[];
  /**
   * The raw branch-scoped rows before any participation transform, for
   * surfaces whose flags recombine the lanes (e.g. `list --imported`).
   */
  scopedRows: ArtifactRow[];
  /** Every `git-import` row in the window, cross-branch, started_at DESC. */
  importedRows: ArtifactRow[];
  /** `git-import` rows NOT present in `rows` — the trailer count a 'disclose' caller owes. */
  importedWithheld: number;
}

const IMPORTED_LIST_HINT = 'orcaops list --imported';

/** The one spelling of the imported-provenance badge on row-level renders. */
export const IMPORTED_BADGE = '[imported]';

/**
 * Row badge for an imported artifact, trailing-space form for inline
 * prefixing. One helper so the disclosure tag cannot drift across the
 * list/show/search/digest surfaces.
 */
export function importedTag(originKind: string | null | undefined): string {
  return originKind === 'git-import' ? `${IMPORTED_BADGE} ` : '';
}

/** The one standardized human trailer for imported artifacts withheld from a view. */
export function importedTrailerLine(count: number, hint: string = IMPORTED_LIST_HINT): string {
  return `… and ${count} imported artifact${count === 1 ? '' : 's'} — \`${hint}\``;
}

/** The JSON counterpart of the trailer: `imported_artifacts: { count, hint }`. */
export function importedArtifactsDisclosure(
  count: number,
  hint: string = IMPORTED_LIST_HINT
): { count: number; hint: string } {
  return { count, hint };
}

function sortStartedAtDesc(rows: ArtifactRow[]): ArtifactRow[] {
  // Imported artifacts are backdated, so started_at DESC keeps them
  // naturally after recent live work without a special-case sort key.
  return rows.sort((a, b) => (a.started_at < b.started_at ? 1 : -1));
}

/**
 * The single branch-scoped read resolver. EVERY read arm that scopes
 * artifacts by branch routes through here (enforced by the source sweep in
 * artifact-scope.sweep.test.ts) so imported participation is always an
 * explicit, recorded choice rather than a per-command accident.
 */
export async function resolveBranchReadScope(
  ctx: CliContext,
  flags: { branch?: string; allBranches?: boolean },
  seeded: SeededReadChoice,
  window: ArtifactScopeWindow = {}
): Promise<BranchReadScope> {
  const branch = flags.allBranches
    ? undefined
    : (flags.branch ?? (await ctx.repo.getCurrentBranch()));
  const defaultScope = !flags.allBranches && flags.branch === undefined;
  const scopedRows =
    branch === undefined
      ? ctx.store.store.listArtifacts(window)
      : ctx.store.store.listArtifactsByLineageBranch({ branch, ...window });
  const importedRows = ctx.store.store
    .listArtifacts(window)
    .filter((row) => row.origin_kind === 'git-import');

  let rows: ArtifactRow[];
  if (seeded.imported === 'include') {
    if (defaultScope) {
      const seen = new Set(scopedRows.map((r) => r.id));
      rows = sortStartedAtDesc([...scopedRows, ...importedRows.filter((r) => !seen.has(r.id))]);
    } else {
      rows = scopedRows;
    }
  } else if (seeded.imported === 'disclose') {
    rows = defaultScope ? scopedRows.filter((row) => row.origin_kind !== 'git-import') : scopedRows;
  } else {
    rows = scopedRows.filter((row) => row.origin_kind !== 'git-import');
  }
  const included = new Set(rows.map((r) => r.id));
  const importedWithheld = importedRows.filter((r) => !included.has(r.id)).length;
  return { branch, defaultScope, rows, scopedRows, importedRows, importedWithheld };
}

/**
 * Shared artifact-set resolution for the insight commands (`decisions`,
 * `loose-ends`): branch default / `--all-branches` / `--limit`, the four
 * time-window flags, and a repeatable `--artifact <id>` exact-scope mode.
 *
 * Precedence (pinned): `--artifact` always FIXES the artifact set — window
 * flags never add or remove artifacts in exact-scope mode. What (if
 * anything) the window flags mean for the records *inside* the fixed set is
 * each command's contract: `decisions` filters records by their `ts`;
 * `loose-ends` rejects the combination outright (loose ends are current
 * state).
 */
export interface ArtifactScopeFlags {
  branch?: string;
  allBranches?: boolean;
  limit?: number;
  since?: string;
  until?: string;
  activeSince?: string;
  activeUntil?: string;
  /** Repeatable `--artifact <id>` (exact-scope mode). */
  artifact?: string[];
}

export interface ResolvedArtifactScope {
  rows: ArtifactRow[];
  /** Parsed + normalized window bounds (ISO-Z), per flag. */
  window: { since?: string; until?: string; activeSince?: string; activeUntil?: string };
  /** True when ANY of the four window flags was provided. */
  windowFlagsPresent: boolean;
  /** True when `--artifact` fixed the set. */
  exactScope: boolean;
  /** `git-import` rows withheld from `rows` (0 in exact-scope mode). */
  importedWithheld: number;
  /** Every `git-import` row in the window, cross-branch (0 in exact-scope mode). */
  importedInStore: number;
}

export async function resolveArtifactScope(
  ctx: CliContext,
  flags: ArtifactScopeFlags,
  seeded: SeededReadChoice
): Promise<ResolvedArtifactScope> {
  const since = parseSince(flags.since, 'since');
  const until = parseUntil(flags.until, 'until');
  const activeSince = parseSince(flags.activeSince, 'active-since');
  const activeUntil = parseUntil(flags.activeUntil, 'active-until');
  assertWindowOrdered(since, until, 'since', 'until');
  assertWindowOrdered(activeSince, activeUntil, 'active-since', 'active-until');
  const limit = parseLimit(flags.limit);
  const window = {
    ...(since !== undefined ? { since } : {}),
    ...(until !== undefined ? { until } : {}),
    ...(activeSince !== undefined ? { activeSince } : {}),
    ...(activeUntil !== undefined ? { activeUntil } : {}),
  };
  const windowFlagsPresent = Object.keys(window).length > 0;

  const explicitIds = [...new Set(flags.artifact ?? [])];
  if (explicitIds.length > 0) {
    const rows = explicitIds.map((id) => {
      const row = ctx.store.store.getArtifact(id);
      if (!row) {
        throw new OrcaopsError(ErrorCodes.UNKNOWN_ARTIFACT, `No artifact with id "${id}".`);
      }
      return row;
    });
    return {
      rows,
      window,
      windowFlagsPresent,
      exactScope: true,
      importedWithheld: 0,
      importedInStore: 0,
    };
  }

  const scope = await resolveBranchReadScope(ctx, flags, seeded, window);
  let rows = scope.rows;
  if (limit !== undefined) rows = rows.slice(0, limit);
  return {
    rows,
    window,
    windowFlagsPresent,
    exactScope: false,
    importedWithheld: scope.importedWithheld,
    importedInStore: scope.importedRows.length,
  };
}
