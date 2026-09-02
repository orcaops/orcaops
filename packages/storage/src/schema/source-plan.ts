import { z } from 'zod';

/**
 * Reference to a source plan — the dedicated *slice plan* an artifact's
 * work is graded against. Deliberately a *ref*, not a bare
 * path: the resolver owns interpretation, so the cloud backend slots in
 * without reshaping storage or the conformance evaluator.
 *
 * `kind: 'local'` is a filesystem path (`version` reserved/unset).
 * `kind: 'cloud'` references an approved plan pulled from a web review
 * surface — `locator` is the cloud `externalId`, `version` the pinned
 * version (decimal string), and `base_url` + `org_id` embed the origin
 * so the Branch-A push guard can verify org/host **without consulting
 * the pull-cache** (the frozen pin is self-contained). Downstream
 * consumers stay kind-agnostic: `toSourcePlanContext` and the digest
 * read only kind/locator/version/hash, so the extra cloud fields are
 * ignored everywhere except the push guard.
 */
export const SourceRefSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('local'),
    /** The ref exactly as the caller passed it (a path, for `local`). */
    locator: z.string().min(1),
    version: z.string().min(1).optional(),
  }),
  z.object({
    kind: z.literal('cloud'),
    /** The plan's cloud `externalId` (unique per org). */
    locator: z.string().min(1),
    /** The pinned version number, as a decimal string (e.g. `"3"`). */
    version: z.string().min(1),
    /** Resolved cloud base URL the pin was pulled from (origin embedded). */
    base_url: z.string().min(1),
    /** Authoritative org id (from `cli.ping`) the pin was pulled under. */
    org_id: z.string().min(1),
  }),
]);
export type SourceRef = z.infer<typeof SourceRefSchema>;

/**
 * Advisory authoring baseline for a pinned source plan: the git state
 * the plan body was captured against (`repo_url` @ `head_sha` on
 * `branch`), frozen at `capture plan` for LOCAL pins only — a cloud
 * pin's authoring baseline already lives cloud-side from `plan upload`.
 * Structurally mirrors the protocol's `OssSourcePlanBaseline` output
 * shape; defined locally because `@orcaops/storage` must not depend on
 * `@orcaops/protocol`. Every component is REQUIRED-NULLABLE (no
 * remote / detached HEAD / empty repo), with no defaults: a
 * present-but-partial baseline object fails the parse loudly. The event
 * rebuilder applies this same schema without repair or field stripping,
 * and the pin field below normalizes on parse (see `normalizeBaseline`)
 * so "no baseline" has exactly one persisted encoding.
 */
export const SourcePlanBaselineSchema = z.object({
  repo_url: z.string().nullable(),
  branch: z.string().nullable(),
  head_sha: z.string().nullable(),
});
export type SourcePlanBaseline = z.infer<typeof SourcePlanBaselineSchema>;

/**
 * Single persisted encoding for "no baseline": whitespace-only
 * components normalize to null (the cloud treats trimmed-empty as
 * absent, so OSS must not persist a value the cloud would store as
 * null) and an all-null object collapses to a null baseline —
 * mirroring resolveReviewBaseline's own collapse so a hand-built
 * `branch: ""` cannot diverge from what a real producer would have
 * written. (A partial object like `baseline: {}` never reaches this
 * normalization — the required-nullable components fail the parse
 * first.)
 */
function normalizeBaseline(b: SourcePlanBaseline | null): SourcePlanBaseline | null {
  if (b === null) return null;
  const emptyToNull = (v: string | null): string | null =>
    v !== null && v.trim().length > 0 ? v : null;
  const norm = {
    repo_url: emptyToNull(b.repo_url),
    branch: emptyToNull(b.branch),
    head_sha: emptyToNull(b.head_sha),
  };
  if (norm.repo_url === null && norm.branch === null && norm.head_sha === null) return null;
  return norm;
}

/**
 * Immutable pinned snapshot of a source plan, frozen onto the artifact
 * at `capture plan` and projected set-once onto `artifact.json`
 * (a `plan_revised` never disturbs it — freeze at capture). The
 * conformance evaluator grades the artifact's `plan_steps` / `non_goals`
 * against `content`.
 *
 * `content` is the FULL plan text — **never truncated**. A truncated
 * anchor has blind spots the evaluator can't flag, silently reopening
 * the very gap this check closes; hence no `.max(...)`.
 *
 * It must also be non-blank: an empty or whitespace-only file gives the
 * conformance judge nothing to grade against, so it is rejected rather
 * than pinned as a useless anchor. The refinement is *non-transforming*
 * — `content` and its `hash` stay the byte-for-byte original (the hash
 * must remain the sha256 of the file as read).
 */
export const SourcePlanPinSchema = z.object({
  source_ref: SourceRefSchema,
  content: z.string().refine((s) => s.trim().length > 0, {
    message: 'source plan content must not be empty',
  }),
  /** sha256 hex digest of `content`. */
  hash: z.string().min(1),
  baseline: SourcePlanBaselineSchema.nullable().transform(normalizeBaseline),
});
export type SourcePlanPin = z.infer<typeof SourcePlanPinSchema>;
