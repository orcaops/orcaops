import { OssSourcePlanBaseline } from '@orcaops/protocol';

import { canonicalizeRemoteUrl, type HostResolver } from './repo-url.js';

// Re-exported for the CLI: the vendored SDK does not re-export the baseline
// wire type, and the CLI has no direct @orcaops/protocol dependency.
export type { OssSourcePlanBaseline } from '@orcaops/protocol';

/**
 * Structural subset of `Repo` the baseline resolver needs — fakeable in tests
 * without a real working tree.
 */
export interface BaselineRepo {
  getRemoteUrl(remote?: string): Promise<string | null>;
  getCurrentBranch(): Promise<string>;
  getHeadSha(): Promise<string>;
}

/**
 * The canonicalized current remote for the cloud wire, or null. Never throws.
 *
 * Wraps `getRemoteUrl` (null when origin isn't configured) +
 * `canonicalizeRemoteUrl` (the WIRE variant — resolves SSH host aliases; NOT
 * `normalizeRepoUrl`, which is the local SQLite-PK form). Reviewer discovery
 * and the review baseline both send this, so there is exactly one
 * canonicalization path to the wire.
 */
export async function resolveWireRepoUrl(
  repo: BaselineRepo,
  resolveHost?: HostResolver
): Promise<string | null> {
  try {
    const raw = await repo.getRemoteUrl();
    if (raw === null) return null;
    const canonical = await canonicalizeRemoteUrl(raw, resolveHost);
    return canonical.trim().length > 0 ? canonical : null;
  } catch {
    return null;
  }
}

/**
 * The advisory authoring baseline for a source-plan body: WHERE it was
 * authored (`repo_url` @ `head_sha` on `branch`), populated from the worktree
 * at `plan upload` / `plan review push` / `plan review propose`.
 *
 * Advisory means advisory: each component resolves independently and ANY
 * individual failure nulls just that component — no remote nulls `repo_url`
 * while branch/sha still ship; an empty repo (no commits) nulls `head_sha`;
 * a detached HEAD nulls `branch` (`git rev-parse --abbrev-ref HEAD` reports
 * the literal string "HEAD" there, which is not a branch). All-null collapses
 * to a null baseline (omitted from rendering). The helper itself NEVER
 * throws — git state must never block an upload.
 */
export async function resolveReviewBaseline(
  repo: BaselineRepo,
  resolveHost?: HostResolver
): Promise<OssSourcePlanBaseline | null> {
  const [repoUrl, branch, headSha] = await Promise.all([
    resolveWireRepoUrl(repo, resolveHost),
    resolveBranch(repo),
    resolveHeadSha(repo),
  ]);
  const repo_url = fitsWire('repo_url', repoUrl);
  const branchClamped = fitsWire('branch', branch);
  const head_sha = fitsWire('head_sha', headSha);
  if (repo_url === null && branchClamped === null && head_sha === null) return null;
  return { repo_url, branch: branchClamped, head_sha };
}

/**
 * Advisory degrade for over-cap components: the wire schema enforces
 * max lengths the resolver's sources don't (git allows slash-separated
 * refs past the branch cap; a remote URL can exceed the URL cap). The
 * baseline freezes immutably into pins that are excluded from change
 * detection, so an un-shippable component would wedge background sync
 * with no recovery — null it at resolve time instead, validating with
 * the protocol's own field schemas so the caps can never drift from
 * the wire.
 */
function fitsWire(key: 'repo_url' | 'branch' | 'head_sha', value: string | null): string | null {
  return OssSourcePlanBaseline.shape[key].safeParse(value).success ? value : null;
}

async function resolveBranch(repo: BaselineRepo): Promise<string | null> {
  try {
    const branch = (await repo.getCurrentBranch()).trim();
    // Detached HEAD: `--abbrev-ref HEAD` resolves to the literal "HEAD".
    if (branch.length === 0 || branch === 'HEAD') return null;
    return branch;
  } catch {
    return null;
  }
}

async function resolveHeadSha(repo: BaselineRepo): Promise<string | null> {
  try {
    const sha = (await repo.getHeadSha()).trim();
    return sha.length > 0 ? sha : null;
  } catch {
    return null;
  }
}
