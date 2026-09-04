import { CommitParser } from 'conventional-commits-parser';

import { ARTIFACT_LABEL_MAX } from '@orcaops/storage';

import type { DetailedCommit } from '../git/repo.js';

export const EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
export const DEFAULT_RUN_GAP_MS = 3 * 60 * 60 * 1000;
export const DEFAULT_RUN_CAP = 12;
export const DEFAULT_FOLD_THRESHOLD = 50;

const BOT_PATTERN = /\[bot\]|dependabot|renovate|github-actions/iu;
const BOT_BRANCH_PATTERN = /from \S*\/(?:renovate|dependabot)\//iu;
const RELEASE_PATTERN = /^(?:release|chore\(release\)|publish)[:\s]|^v?\d+\.\d+\.\d+(?:-\S+)?$/iu;
const MERGE_BODY_NOISE_PATTERN =
  /^#|^(?:[a-z]+(?:-[a-z]+)*-by|change-id|fixes|closes|resolves|refs?|see-also|cc|link|bug|issue):\s/iu;
const TRAILER_LINE_PATTERN = /^[a-z][a-z0-9-]*:\s+\S/iu;
const CONVENTIONAL_BODY_TITLE_PATTERN =
  /^(?:build|chore|ci|docs|feat|fix|perf|refactor|revert|review|style|test)(?:\([^)]+\))?!?:\s+\S/iu;
const CLOSING_REFERENCE_PATTERN =
  /^(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#\d+(?:\s*(?:,|and)\s*#\d+)*[.!]?$/iu;
// A merge subject that names only the mechanics ("Merge branch 'x'",
// "Merge tag '4.11.1'", "Merge pull request #1 from y", "Merge x into y")
// carries no PR title.
const BARE_MERGE_SUBJECT_PATTERN =
  /^merged?\s+(?:(?:remote-tracking\s+)?branch\b|tag\b|pull\s+request\b|in(?:to)?\s|\S+\s+in(?:to)?\s\S+)/iu;
const SQUASH_PATTERN = /\(#\d+\)$/u;
const LOW_INFORMATION_PATTERN = /^(?:tweaks?|typo|fix ci|wip|misc|\d)/iu;
const LOCKFILES = new Set([
  'bun.lock',
  'bun.lockb',
  'composer.lock',
  'cargo.lock',
  'gemfile.lock',
  'package-lock.json',
  'pnpm-lock.yaml',
  'poetry.lock',
  'yarn.lock',
]);

const commitParser = new CommitParser();

export type SeedClusterKind = 'merge' | 'squash' | 'run' | 'release';

export interface SeedCheckpointGroup {
  key: string;
  commits: DetailedCommit[];
  parentSha: string;
  headSha: string;
  files: string[];
  committerDateIso: string;
}

export interface SeedCluster {
  key: string;
  kind: SeedClusterKind;
  label: string;
  baseSha: string;
  headSha: string;
  commits: DetailedCommit[];
  checkpoints: SeedCheckpointGroup[];
  authors: string[];
  files: string[];
  firstParentPosition: number;
  displayDateIso: string;
  latestCommitDateIso: string;
  conventionalType: string | null;
  conventionalScope: string | null;
  warnings: string[];
}

export interface ClusterHistoryOptions {
  includeBots?: boolean;
  windowStartIso?: string;
  runGapMs?: number;
  runCap?: number;
  foldThreshold?: number;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort(compareText);
}

function commitTime(commit: DetailedCommit): number {
  return Date.parse(commit.committerDateIso);
}

function isBot(commit: DetailedCommit): boolean {
  return BOT_PATTERN.test(commit.authorEmail);
}

function isMechanicalPath(file: string): boolean {
  const normalized = file.replaceAll('\\', '/').toLowerCase();
  const basename = normalized.slice(normalized.lastIndexOf('/') + 1);
  return (
    LOCKFILES.has(basename) ||
    normalized.startsWith('dist/') ||
    normalized.includes('/dist/') ||
    normalized.startsWith('vendor/') ||
    normalized.includes('/vendor/') ||
    /\.min\.[^/]+$/u.test(normalized)
  );
}

/**
 * A release tool's version bump: the subject is a bare version (or a release
 * subject) and nothing outside the package manifest and its lockfile moved.
 * `npm version` writes exactly this shape, and it imports as an artifact
 * titled `2.0.1` whose whole story is "1 commit touching 1 file —
 * package.json". Mechanical in the same sense a lockfile-only commit is.
 *
 * The subject half of the conjunction is load-bearing: a manifest-only commit
 * with a real subject ("feat: add the zod dependency") is genuine history.
 * Clustering is pure, offline and synchronous, so the predicate reads paths
 * and subjects only — confirming that literally just the version FIELD moved
 * would need a per-commit diff read this layer deliberately does not do.
 */
function isVersionBumpCommit(commit: DetailedCommit): boolean {
  if (!RELEASE_PATTERN.test(commit.subject.trim())) return false;
  return commit.files.some((file) => isManifestPath(file));
}

function isManifestPath(file: string): boolean {
  const normalized = file.replaceAll('\\', '/').toLowerCase();
  return normalized === 'package.json' || normalized.endsWith('/package.json');
}

export function isSeedableCommit(commit: DetailedCommit, includeBots = false): boolean {
  if (!includeBots && isBot(commit)) return false;
  if (commit.files.length === 0) return false;
  if (commit.files.every(isMechanicalPath)) return false;
  return !(
    isVersionBumpCommit(commit) &&
    commit.files.every((file) => isManifestPath(file) || isMechanicalPath(file))
  );
}

/**
 * git nests revert subjects as `Revert "Revert "X""` (and revert-of-revert
 * as `Reapply "X"`) with the inner quotes unescaped, so each unwrap level
 * must strip the wrapper and its closing quote as one balanced pair —
 * stripping the prefix alone leaves a stray trailing quote per level. The
 * anchored greedy capture takes exactly one pair per iteration; unbalanced
 * subjects never match and stay verbatim.
 */
const REVERT_WRAPPER = /^(Revert|Reapply)\s+"([\s\S]*)"$/u;

function unwrapRevertSubject(subject: string): {
  subject: string;
  netRevert: boolean;
  wrapped: boolean;
} {
  let current = subject.trim();
  let reverts = 0;
  let wrapped = false;
  for (;;) {
    const match = REVERT_WRAPPER.exec(current);
    if (!match) break;
    wrapped = true;
    if (match[1] === 'Revert') reverts += 1;
    current = match[2]!.trim();
  }
  return { subject: current, netRevert: reverts % 2 === 1, wrapped };
}

/**
 * Display form of a commit subject: revert/reapply wrappers unwrapped to a
 * `revert:`/`reapply:` prefix on the inner subject (kept verbatim, its own
 * type/scope included). Read surfaces that TRUNCATE subjects must render
 * this form — the raw `Revert "…"` wrapper loses its closing quote to
 * truncation and reads as garble.
 */
export function displaySubject(subject: string): string {
  const unwrapped = unwrapRevertSubject(subject);
  if (!unwrapped.wrapped) return subject.trim();
  return `${unwrapped.netRevert ? 'revert' : 'reapply'}: ${unwrapped.subject}`;
}

function parsedSubject(subject: string): {
  label: string;
  type: string | null;
  scope: string | null;
} {
  const unwrapped = unwrapRevertSubject(subject);
  const parsed = commitParser.parse(unwrapped.subject);
  const label = parsed.subject?.trim() || unwrapped.subject.trim();
  return {
    label: unwrapped.wrapped ? `${unwrapped.netRevert ? 'revert' : 'reapply'}: ${label}` : label,
    type: parsed.type?.trim() || null,
    scope: parsed.scope?.trim() || null,
  };
}

function informationScore(commit: DetailedCommit): number {
  const parsed = parsedSubject(commit.subject);
  let score = parsed.label.length;
  if (LOW_INFORMATION_PATTERN.test(parsed.label)) score -= 1_000;
  if (parsed.type === 'feat' || parsed.type === 'fix') score += 100;
  if (commit.body.trim().length > 0) score += 20;
  return score;
}

function bestMember(commits: readonly DetailedCommit[]): DetailedCommit {
  return [...commits].sort(
    (a, b) => informationScore(b) - informationScore(a) || compareText(a.sha, b.sha)
  )[0]!;
}

function truncateRunLabel(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

/**
 * The kept prefix of a word-boundary truncation to `max` (ellipsis budget
 * included): never ends mid-word — a mid-word cut reads as garble in
 * listings — unless the text is one long token. Callers append the ellipsis
 * (and any quote balancing) themselves.
 */
export function wordBoundaryPrefix(text: string, max: number): string {
  const hard = text.slice(0, Math.max(1, max - 1));
  const cutAtBoundary = text[max - 1] === ' ' || hard.endsWith(' ');
  const lastSpace = hard.lastIndexOf(' ');
  return cutAtBoundary || lastSpace <= 0 ? hard.trimEnd() : hard.slice(0, lastSpace).trimEnd();
}

/** Like truncateRunLabel, but never ends mid-word (single long tokens excepted). */
export function truncateAtWordBoundary(text: string, max: number): string {
  return text.length <= max ? text : `${wordBoundaryPrefix(text, max)}…`;
}

/**
 * A run is a work session, and one session often spans several tasks. Task
 * groups are the distinct conventional `type(scope)` combinations among the
 * member subjects (non-conventional subjects share one group), ordered
 * largest first so the dominant task leads the label. Composing the label
 * instead of splitting the run keeps cluster identity stable — a split
 * would be a clustering-rule change requiring an id-salt bump.
 */
function runTaskGroups(members: readonly DetailedCommit[]): DetailedCommit[][] {
  const groups = new Map<string, DetailedCommit[]>();
  for (const member of members) {
    const parsed = parsedSubject(member.subject);
    const key = parsed.type ? `${parsed.type}(${parsed.scope ?? ''})` : '';
    const group = groups.get(key);
    if (group) group.push(member);
    else groups.set(key, [member]);
  }
  return [...groups.values()].sort(
    (a, b) =>
      b.length - a.length ||
      informationScore(bestMember(b)) - informationScore(bestMember(a)) ||
      compareText(bestMember(a).sha, bestMember(b).sha)
  );
}

/**
 * A single `type(scope)` group can still span several tasks (one long
 * `fix(seed)` session covering five distinct problems). Requiring this many
 * mutually distinct informative subjects before qualifying the label keeps
 * ordinary "one task, several commits" runs unqualified.
 */
const MULTI_TASK_SUBJECT_MIN = 3;

/** Distinct member subjects after normalization, low-information ones excluded. */
export function distinctInformativeSubjects(members: readonly DetailedCommit[]): number {
  const distinct = new Set<string>();
  for (const member of members) {
    if (informationScore(member) <= 0) continue;
    const normalized = parsedSubject(member.subject)
      .label.toLowerCase()
      .replace(/\s+/gu, ' ')
      .replace(/[.!?]+$/u, '')
      .trim();
    if (normalized.length > 0) distinct.add(normalized);
  }
  return distinct.size;
}

/**
 * Truthful multi-task qualifier for a single-group run: the label shows the
 * best subject, so say how many OTHER distinct tasks the session carried
 * instead of pretending the cluster is one task.
 */
function appendMultiTaskQualifier(base: string, others: number, type: string | null): string {
  const noun = type === 'fix' ? 'fixes' : type === 'feat' ? 'features' : 'changes';
  const suffix = ` (+${others} more ${noun})`;
  if (base.length + suffix.length <= ARTIFACT_LABEL_MAX) return `${base}${suffix}`;
  return `${truncateAtWordBoundary(base, ARTIFACT_LABEL_MAX - suffix.length)}${suffix}`;
}

function composeRunLabel(
  primary: string,
  secondary: string,
  otherTasks: number,
  qualifierType: string | null
): string {
  const joined = `${primary} + ${secondary}`;
  if (joined.length <= ARTIFACT_LABEL_MAX) return joined;
  // Truncation priority goes to the larger group: its subject stays whole
  // unless the leftover budget cannot hold a readable fragment.
  const budget = ARTIFACT_LABEL_MAX - primary.length - ' + '.length;
  if (budget >= 12) return `${primary} + ${truncateRunLabel(secondary, budget)}`;
  // Composition cannot fit — fall back to the counted qualifier so a
  // multi-task run is never rendered as a bare single-task subject.
  return appendMultiTaskQualifier(primary, otherTasks, qualifierType);
}

/**
 * A subject that cannot label a merge cluster: the merge mechanics
 * ("Merge branch 'x'", "Merge tag '4.11.1'") or a release train ("4.19.0"),
 * both naming the ceremony rather than the work the side branch carried.
 *
 * This is the one place a merge subject meets RELEASE_PATTERN — clusterSeedHistory
 * classifies by parent count and continues before the release branch runs, and
 * isVersionBumpCommit only sees single-parent members. Reusing it costs a false
 * positive on "Release the lock earlier", which is label-only and still resolves
 * to a real member subject.
 */
function isCeremonialMergeSubject(subject: string): boolean {
  const trimmed = subject.trim();
  return BARE_MERGE_SUBJECT_PATTERN.test(trimmed) || RELEASE_PATTERN.test(trimmed);
}

function terminalMergeNoiseStart(lines: readonly string[]): number | null {
  let index = lines.length - 1;
  while (index >= 0 && lines[index]!.trim().length === 0) index -= 1;
  let start = index + 1;
  let found = false;
  while (index >= 0) {
    let recordStart = index;
    while (recordStart >= 0 && /^\s/u.test(lines[recordStart]!)) recordStart -= 1;
    if (recordStart < 0) break;
    const trimmed = lines[recordStart]!.trim();
    const trailer =
      TRAILER_LINE_PATTERN.test(trimmed) && !CONVENTIONAL_BODY_TITLE_PATTERN.test(trimmed);
    if (trailer || CLOSING_REFERENCE_PATTERN.test(trimmed)) {
      found = true;
      start = recordStart;
      index = recordStart - 1;
      continue;
    }
    break;
  }
  return found ? start : null;
}

/**
 * `fromMember` marks a label taken from ONE member rather than the branch's own
 * title, which is what entitles the caller to qualify it with a task count.
 */
function mergeLabelSubject(
  merge: DetailedCommit,
  members: readonly DetailedCommit[]
): { subject: string; fromMember: boolean } {
  const bodyLines = merge.body.split(/\r?\n/u);
  const terminalNoiseStart = terminalMergeNoiseStart(bodyLines);
  const bodyLabel = bodyLines
    .slice(0, terminalNoiseStart ?? bodyLines.length)
    .map((line) => line.trim())
    .find(
      (line) =>
        line.length > 0 && !MERGE_BODY_NOISE_PATTERN.test(line) && !isCeremonialMergeSubject(line)
    );
  if (bodyLabel) return { subject: bodyLabel, fromMember: false };
  if (!isCeremonialMergeSubject(merge.subject)) {
    return { subject: merge.subject, fromMember: false };
  }
  // A member version bump survives isSeedableCommit when it also touches
  // source, so filter those out too. bestMember over ALL members is the
  // never-empty last resort — a terse subject is still testimony, a tag is not.
  const informative = members.filter(
    (member) => informationScore(member) > 0 && !isCeremonialMergeSubject(member.subject)
  );
  const chosen = bestMember(informative.length > 0 ? informative : members).subject.trim();
  return chosen.length > 0
    ? { subject: chosen, fromMember: true }
    : { subject: merge.subject, fromMember: false };
}

function groupCheckpoints(
  commits: readonly DetailedCommit[],
  foldThreshold: number
): SeedCheckpointGroup[] {
  const groups: DetailedCommit[][] = [];
  if (commits.length < foldThreshold) {
    for (const commit of commits) groups.push([commit]);
  } else {
    for (const commit of commits) {
      const day = new Date(commitTime(commit)).toISOString().slice(0, 10);
      const tail = groups.at(-1);
      const tailDay = tail ? new Date(commitTime(tail[0]!)).toISOString().slice(0, 10) : null;
      if (tail && tailDay === day) tail.push(commit);
      else groups.push([commit]);
    }
  }
  return groups.map((members) => {
    const first = members[0]!;
    const last = members.at(-1)!;
    return {
      key: members.length === 1 ? first.sha : `${first.sha}..${last.sha}`,
      commits: [...members],
      parentSha: first.parentShas[0] ?? EMPTY_TREE_SHA,
      headSha: last.sha,
      files: uniqueSorted(members.flatMap((commit) => commit.files)),
      committerDateIso: last.committerDateIso,
    };
  });
}

function makeCluster(input: {
  kind: SeedClusterKind;
  commits: DetailedCommit[];
  headCommit: DetailedCommit;
  baseSha: string;
  firstParentPosition: number;
  labelSubject: string;
  composedLabel?: string;
  warnings?: string[];
  foldThreshold: number;
}): SeedCluster {
  const parsed = parsedSubject(input.labelSubject);
  const latestCommitDateIso = input.commits.reduce(
    (latest, commit) =>
      commitTime(commit) > Date.parse(latest) ? commit.committerDateIso : latest,
    input.commits[0]!.committerDateIso
  );
  const first = input.commits[0]!;
  const last = input.commits.at(-1)!;
  return {
    key:
      input.kind === 'merge'
        ? `merge:${input.headCommit.sha}`
        : `${input.kind}:${first.sha}:${last.sha}`,
    kind: input.kind,
    label: input.composedLabel ?? parsed.label,
    baseSha: input.baseSha,
    headSha: input.headCommit.sha,
    commits: input.commits,
    checkpoints: groupCheckpoints(input.commits, input.foldThreshold),
    authors: uniqueSorted(input.commits.map((commit) => commit.authorEmail)),
    files: uniqueSorted(input.commits.flatMap((commit) => commit.files)),
    firstParentPosition: input.firstParentPosition,
    displayDateIso: input.headCommit.committerDateIso,
    latestCommitDateIso,
    conventionalType: parsed.type,
    conventionalScope: parsed.scope,
    warnings: input.warnings ?? [],
  };
}

function splitRun(commits: DetailedCommit[], cap: number): DetailedCommit[][] {
  if (commits.length <= cap) return [commits];
  const parts = Math.ceil(commits.length / cap);
  type State = { score: number; cuts: number[] };
  const dp: Array<Array<State | undefined>> = Array.from({ length: parts + 1 }, () =>
    Array<State | undefined>(commits.length + 1).fill(undefined)
  );
  dp[0]![0] = { score: 0, cuts: [] };
  for (let part = 1; part <= parts; part++) {
    for (let end = 1; end <= commits.length; end++) {
      for (let length = 1; length <= cap && length <= end; length++) {
        const start = end - length;
        const prior = dp[part - 1]![start];
        if (!prior) continue;
        const gap = start === 0 ? 0 : commitTime(commits[start]!) - commitTime(commits[start - 1]!);
        const candidate = {
          score: prior.score + gap,
          cuts: start === 0 ? prior.cuts : [...prior.cuts, start],
        };
        const current = dp[part]![end];
        if (
          !current ||
          candidate.score > current.score ||
          (candidate.score === current.score && candidate.cuts.join(',') > current.cuts.join(','))
        ) {
          dp[part]![end] = candidate;
        }
      }
    }
  }
  const cuts = dp[parts]![commits.length]?.cuts;
  if (!cuts) throw new Error('Unable to partition seed run within the commit cap');
  const boundaries = [0, ...cuts, commits.length];
  return boundaries.slice(0, -1).map((start, index) => commits.slice(start, boundaries[index + 1]));
}

function reachableSideCommits(
  starts: readonly string[],
  graph: ReadonlyMap<string, DetailedCommit>,
  reachableBefore: ReadonlySet<string>
): Set<string> {
  const found = new Set<string>();
  const stack = [...starts];
  while (stack.length > 0) {
    const sha = stack.pop()!;
    if (reachableBefore.has(sha) || found.has(sha)) continue;
    found.add(sha);
    const commit = graph.get(sha);
    if (commit) stack.push(...commit.parentShas);
  }
  return found;
}

export function clusterSeedHistory(
  firstParentNewestFirst: readonly DetailedCommit[],
  graphCommits: readonly DetailedCommit[],
  opts: ClusterHistoryOptions = {}
): SeedCluster[] {
  const includeBots = opts.includeBots ?? false;
  const runGapMs = opts.runGapMs ?? DEFAULT_RUN_GAP_MS;
  const runCap = opts.runCap ?? DEFAULT_RUN_CAP;
  const foldThreshold = opts.foldThreshold ?? DEFAULT_FOLD_THRESHOLD;
  const windowStartMs = opts.windowStartIso ? Date.parse(opts.windowStartIso) : null;
  if (windowStartMs !== null && Number.isNaN(windowStartMs)) {
    throw new TypeError('windowStartIso must be an ISO timestamp');
  }
  if (!Number.isSafeInteger(runCap) || runCap <= 0) throw new RangeError('runCap must be positive');
  if (!Number.isSafeInteger(foldThreshold) || foldThreshold <= 0) {
    throw new RangeError('foldThreshold must be positive');
  }

  const graph = new Map(graphCommits.map((commit) => [commit.sha, commit]));
  const firstParent = [...firstParentNewestFirst].reverse();
  const reachableBefore = new Set<string>();
  const assigned = new Set<string>();
  const clusters: SeedCluster[] = [];
  let run: DetailedCommit[] = [];

  const flushRun = (): void => {
    if (run.length === 0) return;
    for (const members of splitRun(run, runCap)) {
      const groups = runTaskGroups(members);
      const informative = groups.filter((group) => informationScore(bestMember(group)) > 0);
      const labelGroups = informative.length > 0 ? informative : groups;
      const labelCommit = bestMember(labelGroups[0]!);
      const secondary = labelGroups[1];
      const otherGroups = labelGroups.slice(1);
      const otherTypes = new Set(
        otherGroups.map((group) => parsedSubject(bestMember(group).subject).type)
      );
      let composedLabel = secondary
        ? composeRunLabel(
            parsedSubject(labelCommit.subject).label,
            parsedSubject(bestMember(secondary).subject).label,
            otherGroups.length,
            otherTypes.size === 1 ? [...otherTypes][0]! : null
          )
        : undefined;
      if (!secondary) {
        // Label-only: cluster boundaries and keys never change here.
        const distinct = distinctInformativeSubjects(labelGroups[0]!);
        if (distinct >= MULTI_TASK_SUBJECT_MIN) {
          const parsed = parsedSubject(labelCommit.subject);
          composedLabel = appendMultiTaskQualifier(parsed.label, distinct - 1, parsed.type);
        }
      }
      const head = members.at(-1)!;
      clusters.push(
        makeCluster({
          kind: 'run',
          commits: members,
          headCommit: head,
          baseSha: members[0]!.parentShas[0] ?? EMPTY_TREE_SHA,
          firstParentPosition: firstParent.indexOf(head),
          labelSubject: labelCommit.subject,
          ...(composedLabel ? { composedLabel } : {}),
          foldThreshold,
        })
      );
      for (const commit of members) assigned.add(commit.sha);
    }
    run = [];
  };

  for (let position = 0; position < firstParent.length; position++) {
    const commit = firstParent[position]!;
    if (commit.parentShas.length > 1) {
      flushRun();
      const sideReachable = reachableSideCommits(
        commit.parentShas.slice(1),
        graph,
        reachableBefore
      );
      const rawMembers = [...sideReachable]
        .map((sha) => graph.get(sha))
        .filter((member): member is DetailedCommit => member !== undefined)
        .filter((member) => member.parentShas.length <= 1)
        .sort((a, b) => commitTime(a) - commitTime(b) || compareText(a.sha, b.sha));
      const spanMs = rawMembers.length
        ? commitTime(rawMembers.at(-1)!) - commitTime(rawMembers[0]!)
        : 0;
      const warnings = spanMs > 30 * 24 * 60 * 60 * 1000 ? ['long-lived branch import'] : [];
      const branchLooksAutomated = BOT_BRANCH_PATTERN.test(commit.subject);
      const allMembersAreBots = rawMembers.length > 0 && rawMembers.every(isBot);
      const members = rawMembers.filter(
        (member) =>
          !assigned.has(member.sha) &&
          (windowStartMs === null || commitTime(member) >= windowStartMs) &&
          isSeedableCommit(member, includeBots)
      );
      if (members.length > 0 && (includeBots || (!branchLooksAutomated && !allMembersAreBots))) {
        // Label-only: cluster boundaries and keys never change here. A
        // member-derived label is one-of-N by construction, so count the other
        // tasks; a branch's own title already covers them, hence the gate.
        const mergeLabel = mergeLabelSubject(commit, members);
        let composedLabel: string | undefined;
        if (mergeLabel.fromMember) {
          const distinct = distinctInformativeSubjects(members);
          if (distinct >= MULTI_TASK_SUBJECT_MIN) {
            const parsed = parsedSubject(mergeLabel.subject);
            composedLabel = appendMultiTaskQualifier(parsed.label, distinct - 1, parsed.type);
          }
        }
        clusters.push(
          makeCluster({
            kind: 'merge',
            commits: members,
            headCommit: commit,
            baseSha: commit.parentShas[0]!,
            firstParentPosition: position,
            labelSubject: mergeLabel.subject,
            ...(composedLabel ? { composedLabel } : {}),
            warnings,
            foldThreshold,
          })
        );
        for (const member of members) assigned.add(member.sha);
      }
      for (const sha of sideReachable) reachableBefore.add(sha);
      reachableBefore.add(commit.sha);
      continue;
    }

    reachableBefore.add(commit.sha);
    if (assigned.has(commit.sha) || !isSeedableCommit(commit, includeBots)) {
      flushRun();
      continue;
    }
    const isRelease = RELEASE_PATTERN.test(commit.subject);
    const isSquash = SQUASH_PATTERN.test(commit.subject);
    if (isRelease || isSquash) {
      flushRun();
      clusters.push(
        makeCluster({
          kind: isRelease ? 'release' : 'squash',
          commits: [commit],
          headCommit: commit,
          baseSha: commit.parentShas[0] ?? EMPTY_TREE_SHA,
          firstParentPosition: position,
          labelSubject: commit.subject,
          foldThreshold,
        })
      );
      assigned.add(commit.sha);
      continue;
    }

    const previous = run.at(-1);
    if (
      previous &&
      (previous.authorEmail !== commit.authorEmail ||
        commitTime(commit) - commitTime(previous) > runGapMs)
    ) {
      flushRun();
    }
    run.push(commit);
  }
  flushRun();

  return clusters.sort(
    (a, b) => a.firstParentPosition - b.firstParentPosition || compareText(a.key, b.key)
  );
}
