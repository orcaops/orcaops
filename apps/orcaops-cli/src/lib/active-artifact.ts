import type { ArtifactJson, ArtifactRow } from '@orcaops/storage';

import type { CliContext } from './context.js';
import { type ArtifactCandidate, ErrorCodes, OrcaopsError } from '../io/errors.js';

/** An in-flight artifact (not yet summarized) paired with its on-disk JSON. */
export interface InFlightArtifact {
  row: ArtifactRow;
  json: ArtifactJson;
}

/**
 * Friendly display label for an artifact: the plan headline when it carries
 * one, else the longer `task`. The `'unlabelled'` sentinel (the storage
 * default when no label was ever set) falls back to `task` too.
 */
export function deriveLabel(row: ArtifactRow): string {
  return row.label && row.label !== 'unlabelled' ? row.label : row.task;
}

/**
 * In-flight (state !== 'summarized') artifacts whose lineage includes
 * `branch`, newest-first. The summarized filter is the load-bearing
 * invariant shared by `resume`'s resolver, capture autodetect, and the
 * session-start hook reader — keeping it in one place keeps the surfaces in
 * agreement. Accepts any `{ store }` holder (not a full CliContext) so the
 * hook's lightweight no-archive reader can reuse it.
 */
export async function loadInFlightOnBranch(
  ctx: Pick<CliContext, 'store'>,
  branch: string
): Promise<InFlightArtifact[]> {
  const rows = ctx.store.store.listArtifactsByLineageBranch({ branch });
  const result: InFlightArtifact[] = [];
  for (const row of rows) {
    const json = await ctx.store.readArtifact(row.id);
    if (!json) continue;
    if (json.state === 'summarized') continue;
    result.push({ row, json });
  }
  return result;
}

/** Project an in-flight artifact onto the disambiguation candidate shape. */
function toArtifactCandidate({ row, json }: InFlightArtifact): ArtifactCandidate {
  return {
    id: row.id,
    label: deriveLabel(row),
    task: row.task,
    state: json.state,
    checkpoint_count: json.checkpoint_count,
    last_activity_at: json.updated_at,
    created_by_session_id: json.created_by_session_id,
  };
}

export interface ResolveActiveArtifactResult {
  artifactId: string;
  via: 'explicit' | 'single-active';
}

/**
 * Resolve the artifact a capture command should target:
 *   - `explicitId` present  → validate it exists (`UNKNOWN_ARTIFACT` if not),
 *     return it (`via: 'explicit'`).
 *   - exactly one in-flight on the branch → auto-pick (`via: 'single-active'`).
 *   - zero in-flight        → `INVALID_INPUT` (nothing to target).
 *   - more than one         → `AMBIGUOUS_ARTIFACT` with a structured
 *     `candidates[]` payload so the agent re-issues naming one `id`.
 *
 * Deliberately branch-scoped: unlike `resume`, this does NOT consult the pin
 * or the SHA-reachability fallback — those could silently retarget a write to
 * an artifact on a different branch.
 */
export async function resolveActiveArtifactId(
  ctx: CliContext,
  opts: { explicitId?: string; branch?: string }
): Promise<ResolveActiveArtifactResult> {
  if (opts.explicitId !== undefined) {
    const row = ctx.store.store.getArtifact(opts.explicitId);
    if (!row) {
      throw new OrcaopsError(
        ErrorCodes.UNKNOWN_ARTIFACT,
        `No artifact with id "${opts.explicitId}".`,
        'artifact_id'
      );
    }
    return { artifactId: opts.explicitId, via: 'explicit' };
  }

  const branch = opts.branch ?? (await ctx.repo.getCurrentBranch());
  const inFlight = await loadInFlightOnBranch(ctx, branch);

  if (inFlight.length === 1) {
    return { artifactId: inFlight[0].row.id, via: 'single-active' };
  }

  if (inFlight.length === 0) {
    throw new OrcaopsError(
      ErrorCodes.INVALID_INPUT,
      `No active artifact on branch "${branch}". Pass artifact_id explicitly, or run \`orcaops capture plan\` first.`,
      'artifact_id'
    );
  }

  // More than one active artifact — a write can't auto-pick. Hand back a
  // structured candidate list so the agent re-issues naming one id.
  const candidates = inFlight.map(toArtifactCandidate);
  const summary = candidates.map((c) => `${c.id} (${c.label}, ${c.state})`).join('; ');
  throw new OrcaopsError(
    ErrorCodes.AMBIGUOUS_ARTIFACT,
    `${candidates.length} active artifacts on branch "${branch}"; pass artifact_id explicitly. Candidates: ${summary}.`,
    'artifact_id',
    { candidates }
  );
}
