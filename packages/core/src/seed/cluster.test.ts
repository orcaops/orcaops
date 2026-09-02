import { describe, expect, it } from 'vitest';

import { clusterSeedHistory, displaySubject, EMPTY_TREE_SHA } from './cluster.js';
import type { DetailedCommit } from '../git/repo.js';

function commit(name: string, hour: number, input: Partial<DetailedCommit> = {}): DetailedCommit {
  return {
    sha: name.padEnd(40, '0'),
    parentShas: [],
    authorEmail: 'dev@example.com',
    committerDateIso: new Date(Date.UTC(2025, 0, 1, hour)).toISOString(),
    subject: name,
    body: '',
    files: [`src/${name}.ts`],
    ...input,
  };
}

describe('clusterSeedHistory', () => {
  it('clusters linear work by author and committer-date gap and chooses the useful label', () => {
    const root = commit('root', 0, { subject: 'Tweaks' });
    const useful = commit('useful', 1, {
      parentShas: [root.sha],
      subject: 'feat(core): Parse detailed history',
      authorEmail: root.authorEmail,
    });
    const late = commit('late', 6, { parentShas: [useful.sha] });

    const clusters = clusterSeedHistory([late, useful, root], [late, useful, root]);
    expect(clusters.map((cluster) => cluster.commits.map((member) => member.sha))).toEqual([
      [root.sha, useful.sha],
      [late.sha],
    ]);
    expect(clusters[0]).toMatchObject({
      label: 'Parse detailed history',
      conventionalType: 'feat',
      conventionalScope: 'core',
      baseSha: EMPTY_TREE_SHA,
    });
  });

  it('composes a run label from both task groups when subjects span scopes', () => {
    const ledgerA = commit('ledger-a', 0, {
      subject: 'feat(seed): job ledger view and durable discovery suppression',
    });
    const ledgerB = commit('ledger-b', 1, {
      parentShas: [ledgerA.sha],
      subject: 'feat(seed): move durable seed state to the home data root',
    });
    const ledgerC = commit('ledger-c', 2, {
      parentShas: [ledgerB.sha],
      subject: 'feat(seed): render the generation-job ledger in status',
    });
    const targeted = commit('targeted', 3, {
      parentShas: [ledgerC.sha],
      subject: 'fix(seed): stop recency-filtering targeted seeds and explain zero results',
      body: 'Targeted lanes select from canonical clusters.\n',
    });
    const history = [targeted, ledgerC, ledgerB, ledgerA];

    const [run] = clusterSeedHistory(history, history);
    expect(run?.label.length).toBeLessThanOrEqual(70);
    expect(run?.label).toMatch(/^job ledger view and durable discovery suppression \+ stop /u);
    expect(run?.conventionalType).toBe('feat');
    expect(run?.conventionalScope).toBe('seed');
  });

  it('qualifies a single-scope run label that spans several distinct tasks', () => {
    const subjects = [
      'fix(seed): rerun clean Fastify scale smoke',
      'fix(seed): verify imported artifact containment',
      'fix(seed): bound coverage from checkpoint open head',
      'fix(seed): bound coverage from checkpoint open head',
      'fix(seed): probe partial-clone backfill support',
      'fix(seed): probe partial-clone backfill support',
      'fix(seed): cover live checkpoint commit ranges',
      'fix(seed): cover live checkpoint commit ranges',
      'fix(seed): cover live checkpoint commit ranges',
    ];
    const commits = subjects.map((subject, index) =>
      commit(`multi-${index}`, index, {
        subject,
        ...(index > 0 ? { parentShas: [`multi-${index - 1}`.padEnd(40, '0')] } : {}),
      })
    );
    const history = [...commits].reverse();

    const clusters = clusterSeedHistory(history, history);
    // Label-only change: one nine-commit run cluster, boundaries untouched.
    expect(clusters).toHaveLength(1);
    const run = clusters[0]!;
    expect(run.commits).toHaveLength(9);
    expect(run.key).toBe(`run:${commits[0]!.sha}:${commits[8]!.sha}`);
    expect(run.label).toBe('bound coverage from checkpoint open head (+4 more fixes)');
    expect(run.label.length).toBeLessThanOrEqual(70);
  });

  it('leaves a single-task run label unqualified', () => {
    const commits = Array.from({ length: 4 }, (_, index) =>
      commit(`same-${index}`, index, {
        subject: 'fix(seed): cover live checkpoint commit ranges',
        ...(index > 0 ? { parentShas: [`same-${index - 1}`.padEnd(40, '0')] } : {}),
      })
    );
    const history = [...commits].reverse();

    const [run] = clusterSeedHistory(history, history);
    expect(run?.label).toBe('cover live checkpoint commit ranges');
  });

  it('trims a qualified label at a word boundary when the subject overflows', () => {
    const long = 'fix(seed): reconcile enrichment bundle retargeting across resumed jobs';
    const subjects = [
      long,
      'fix(seed): verify imported artifact containment everywhere',
      'fix(seed): bound coverage from checkpoint open head again',
    ];
    const commits = subjects.map((subject, index) =>
      commit(`wide-${index}`, index, {
        subject,
        ...(index > 0 ? { parentShas: [`wide-${index - 1}`.padEnd(40, '0')] } : {}),
      })
    );
    const history = [...commits].reverse();

    const [run] = clusterSeedHistory(history, history);
    expect(run?.label.length).toBeLessThanOrEqual(70);
    // The subject is cut at a word boundary ("resumed" dropped whole),
    // never mid-word.
    expect(run?.label).toBe('reconcile enrichment bundle retargeting across… (+2 more fixes)');
  });

  it('keeps the composed label whole when both subjects fit the budget', () => {
    const feat = commit('feat', 0, { subject: 'feat(cli): add export command' });
    const fix = commit('fix', 1, {
      parentShas: [feat.sha],
      subject: 'fix(docs): correct the install steps',
    });

    // Equal-sized groups: the more informative subject leads the label.
    const [run] = clusterSeedHistory([fix, feat], [fix, feat]);
    expect(run?.label).toBe('correct the install steps + add export command');
  });

  it('discloses dropped task groups when the composition cannot fit', () => {
    const subjects = [
      'fix(seed): reconcile enrichment bundle retargeting across resumed jobs',
      'fix(seed): reconcile enrichment bundle retargeting across resumed jobs',
      'fix(seed): reconcile enrichment bundle retargeting across resumed jobs',
      'fix(seed): reconcile enrichment bundle retargeting across resumed jobs',
      'fix(list): verify imported artifact containment everywhere',
      'fix(list): verify imported artifact containment everywhere',
      'fix(list): verify imported artifact containment everywhere',
      'fix(diff): bound coverage from checkpoint open head again',
      'fix(diff): bound coverage from checkpoint open head again',
    ];
    const commits = subjects.map((subject, index) =>
      commit(`groups-${index}`, index, {
        subject,
        ...(index > 0 ? { parentShas: [`groups-${index - 1}`.padEnd(40, '0')] } : {}),
      })
    );
    const history = [...commits].reverse();

    const clusters = clusterSeedHistory(history, history);
    expect(clusters).toHaveLength(1);
    const run = clusters[0]!;
    expect(run.commits).toHaveLength(9);
    // The primary subject leaves under 12 chars for the secondary, so the
    // composition falls back to the counted qualifier — never a bare
    // single-task subject over a three-task run.
    expect(run.label).toBe('reconcile enrichment bundle retargeting across… (+2 more fixes)');
    expect(run.label.length).toBeLessThanOrEqual(70);
  });

  it('unwraps a revert subject into a truthful label', () => {
    const [run] = clusterSeedHistory(
      [commit('rev', 0, { subject: 'Revert "feat(cloud-sync): stop the periodic drain"' })],
      [commit('rev', 0, { subject: 'Revert "feat(cloud-sync): stop the periodic drain"' })]
    );
    expect(run?.label).toBe('revert: stop the periodic drain');
    expect(run?.conventionalType).toBe('feat');
    expect(run?.conventionalScope).toBe('cloud-sync');
  });

  it('unwraps a revert-of-revert without leaving doubled quotes', () => {
    const nested = commit('nested', 0, {
      subject: 'Revert "Revert "feat(cloud-sync): stop the periodic drain""',
    });
    const [run] = clusterSeedHistory([nested], [nested]);
    expect(run?.label).toBe('reapply: stop the periodic drain');
    expect(run?.label).not.toContain('"');
  });

  it('treats a Reapply wrapper as a reapplication', () => {
    const reapply = commit('reapply', 0, {
      subject: 'Reapply "feat(cloud-sync): stop the periodic drain"',
    });
    const [run] = clusterSeedHistory([reapply], [reapply]);
    expect(run?.label).toBe('reapply: stop the periodic drain');
  });

  it('keeps an unbalanced revert subject verbatim', () => {
    const unbalanced = commit('unbal', 0, {
      subject: 'Revert "feat(cloud-sync): stop the periodic drain',
    });
    const [run] = clusterSeedHistory([unbalanced], [unbalanced]);
    expect(run?.label).toBe('Revert "feat(cloud-sync): stop the periodic drain');
  });

  it('never composes a low-information subject into a run label', () => {
    const useful = commit('useful', 0, { subject: 'feat(core): Parse detailed history' });
    const junk = commit('junk', 1, { parentShas: [useful.sha], subject: 'wip' });

    const [run] = clusterSeedHistory([junk, useful], [junk, useful]);
    expect(run?.label).toBe('Parse detailed history');
  });

  it('makes release and squash commits singletons that break runs', () => {
    const a = commit('a', 0);
    const release = commit('release', 1, { parentShas: [a.sha], subject: 'release: v1.2.0' });
    const squash = commit('squash', 2, {
      parentShas: [release.sha],
      subject: 'Add seed command (#42)',
    });
    const b = commit('b', 3, { parentShas: [squash.sha] });

    expect(
      clusterSeedHistory([b, squash, release, a], [b, squash, release, a]).map(
        (cluster) => cluster.kind
      )
    ).toEqual(['run', 'release', 'squash', 'run']);
  });

  it('expands merge sides, flattens nested merges, and does not duplicate mainline commits', () => {
    const root = commit('root', 0);
    const main = commit('main', 1, { parentShas: [root.sha] });
    const sideA = commit('side-a', 2, { parentShas: [root.sha] });
    const nested = commit('nested', 3, { parentShas: [sideA.sha] });
    const sideMerge = commit('side-merge', 4, { parentShas: [sideA.sha, nested.sha] });
    const sideB = commit('side-b', 5, { parentShas: [sideMerge.sha] });
    const merge = commit('merge', 6, {
      parentShas: [main.sha, sideB.sha],
      subject: 'Merge pull request #7 from team/feature',
      body: 'Build useful history\n',
    });
    const graph = [merge, sideB, sideMerge, nested, sideA, main, root];

    const clusters = clusterSeedHistory([merge, main, root], graph);
    const merged = clusters.find((cluster) => cluster.kind === 'merge');
    expect(merged).toMatchObject({
      label: 'Build useful history',
      baseSha: main.sha,
      headSha: merge.sha,
      displayDateIso: merge.committerDateIso,
    });
    expect(merged?.commits.map((member) => member.sha)).toEqual([sideA.sha, nested.sha, sideB.sha]);
    const allMembers = clusters.flatMap((cluster) => cluster.commits.map((member) => member.sha));
    expect(new Set(allMembers).size).toBe(allMembers.length);
  });

  it('labels a merge past conflict markers and trailer lines in its body', () => {
    const root = commit('root', 0);
    const side = commit('side', 1, { parentShas: [root.sha], subject: 'Improve clustering' });
    const merge = commit('merge', 2, {
      parentShas: [root.sha, side.sha],
      subject: "Merge branch 'feature/clustering'",
      body:
        '# Conflicts:\n' +
        '#\tsrc/side.ts\n' +
        'Signed-off-by: Dev <dev@example.com>\n' +
        'Co-authored-by: Pair <pair@example.com>\n' +
        'Improve clustering heuristics\n',
    });

    const clusters = clusterSeedHistory([merge, root], [merge, side, root]);
    expect(clusters.find((cluster) => cluster.kind === 'merge')?.label).toBe(
      'Improve clustering heuristics'
    );
  });

  it('labels a bare merge subject from the most informative member subject', () => {
    const root = commit('root', 0);
    const tweak = commit('tweak', 1, { parentShas: [root.sha], subject: 'tweaks' });
    const useful = commit('useful', 2, {
      parentShas: [tweak.sha],
      subject: 'feat: parse merge trailers',
      body: 'Adds trailer parsing.',
    });
    const merge = commit('merge', 3, {
      parentShas: [root.sha, useful.sha],
      subject: "Merge branch 'feature/trailers' into main",
      body: '# Conflicts:\n#\tsrc/useful.ts\nCo-authored-by: Pair <pair@example.com>\n',
    });

    const clusters = clusterSeedHistory([merge, root], [merge, useful, tweak, root]);
    expect(clusters.find((cluster) => cluster.kind === 'merge')?.label).toBe(
      'parse merge trailers'
    );
  });

  it('labels a merge-tag release train from the most informative member subject', () => {
    const root = commit('root', 0);
    const tweak = commit('tweak', 1, { parentShas: [root.sha], subject: 'tweaks' });
    const useful = commit('useful', 2, {
      parentShas: [tweak.sha],
      subject: 'fix(router): stop double-decoding the path',
      body: 'Paths were decoded twice.',
    });
    const merge = commit('merge', 3, {
      parentShas: [root.sha, useful.sha],
      subject: "Merge tag '4.11.1'",
      // git copies the tag message into the merge body; a bare version there
      // is ceremony too and must not win over the members.
      body: '4.11.1\n',
    });

    const clusters = clusterSeedHistory([merge, root], [merge, useful, tweak, root]);
    expect(clusters.find((cluster) => cluster.kind === 'merge')?.label).toBe(
      'stop double-decoding the path'
    );
  });

  it('labels a merge whose subject is only a version from its members', () => {
    const root = commit('root', 0);
    const useful = commit('useful', 1, {
      parentShas: [root.sha],
      subject: 'feat: add ETag support',
    });
    const merge = commit('merge', 2, {
      parentShas: [root.sha, useful.sha],
      subject: '4.19.0',
    });

    const clusters = clusterSeedHistory([merge, root], [merge, useful, root]);
    expect(clusters.find((cluster) => cluster.kind === 'merge')?.label).toBe('add ETag support');
  });

  it('prefers a merge body title over the members even on a tag merge', () => {
    const root = commit('root', 0);
    const useful = commit('useful', 1, {
      parentShas: [root.sha],
      subject: 'feat: add ETag support',
    });
    const merge = commit('merge', 2, {
      parentShas: [root.sha, useful.sha],
      subject: "Merge tag '3.8.0'",
      body: 'Fix the router path decoder\n',
    });

    const clusters = clusterSeedHistory([merge, root], [merge, useful, root]);
    expect(clusters.find((cluster) => cluster.kind === 'merge')?.label).toBe(
      'Fix the router path decoder'
    );
  });

  it('never labels a merge from a member that is itself a version bump', () => {
    const root = commit('root', 0);
    // Survives isSeedableCommit because it touches source, not just a manifest.
    const bump = commit('bump', 1, {
      parentShas: [root.sha],
      subject: '4.19.1',
      files: ['package.json', 'src/version.ts'],
    });
    const useful = commit('useful', 2, {
      parentShas: [bump.sha],
      subject: 'feat: add ETag support',
    });
    const merge = commit('merge', 3, {
      parentShas: [root.sha, useful.sha],
      subject: "Merge tag '4.19.1'",
    });

    const clusters = clusterSeedHistory([merge, root], [merge, useful, bump, root]);
    expect(clusters.find((cluster) => cluster.kind === 'merge')?.label).toBe('add ETag support');
  });

  it('falls back to a member subject when no member carries information', () => {
    const root = commit('root', 0);
    const wip = commit('wip', 1, { parentShas: [root.sha], subject: 'wip' });
    const tweak = commit('tweak', 2, { parentShas: [wip.sha], subject: 'tweaks' });
    const merge = commit('merge', 3, {
      parentShas: [root.sha, tweak.sha],
      subject: "Merge tag '3.8.0'",
    });

    const label = clusterSeedHistory([merge, root], [merge, tweak, wip, root]).find(
      (cluster) => cluster.kind === 'merge'
    )?.label;
    // Terse, but real testimony about the work — and never empty, which the
    // plan label schema's min(1) would reject at apply time.
    expect(label).not.toContain('Merge tag');
    expect(label).toBeTruthy();
    expect(['wip', 'tweaks']).toContain(label);
  });

  it('counts the other tasks a ceremonial merge carried', () => {
    const root = commit('root', 0);
    const one = commit('one', 1, { parentShas: [root.sha], subject: 'feat: add ETag support' });
    const two = commit('two', 2, { parentShas: [one.sha], subject: 'feat: add range requests' });
    const three = commit('three', 3, { parentShas: [two.sha], subject: 'feat: add HEAD handling' });
    const merge = commit('merge', 4, {
      parentShas: [root.sha, three.sha],
      subject: "Merge tag '4.14.0'",
    });

    const label = clusterSeedHistory([merge, root], [merge, three, two, one, root]).find(
      (cluster) => cluster.kind === 'merge'
    )?.label;
    expect(label).toMatch(/\(\+2 more features\)$/u);
    expect(label).not.toContain('Merge tag');
  });

  it('leaves a merge labelled from its own title unqualified', () => {
    const root = commit('root', 0);
    const one = commit('one', 1, { parentShas: [root.sha], subject: 'feat: add ETag support' });
    const two = commit('two', 2, { parentShas: [one.sha], subject: 'feat: add range requests' });
    const three = commit('three', 3, { parentShas: [two.sha], subject: 'feat: add HEAD handling' });
    const merge = commit('merge', 4, {
      parentShas: [root.sha, three.sha],
      subject: 'Add conditional request support',
    });

    // The branch's own title already covers the branch; counting other tasks
    // against it would be wrong.
    expect(
      clusterSeedHistory([merge, root], [merge, three, two, one, root]).find(
        (cluster) => cluster.kind === 'merge'
      )?.label
    ).toBe('Add conditional request support');
  });

  it('skips human-merged automated branches and mechanical or empty commits', () => {
    const root = commit('root', 0, { files: ['pnpm-lock.yaml'] });
    const bot = commit('bot', 1, {
      parentShas: [root.sha],
      authorEmail: 'renovate[bot]@users.noreply.github.com',
    });
    const merge = commit('merge', 2, {
      parentShas: [root.sha, bot.sha],
      subject: 'Merge pull request from renovate/pkg',
    });
    const empty = commit('empty', 3, { parentShas: [merge.sha], files: [] });

    expect(clusterSeedHistory([empty, merge, root], [empty, merge, bot, root])).toEqual([]);
  });

  it('skips release-tool version bumps but keeps substantive manifest edits', () => {
    const root = commit('root', 0, { subject: 'feat: establish the package' });
    const bump = commit('bump', 1, {
      parentShas: [root.sha],
      subject: '2.0.1',
      files: ['package.json', 'package-lock.json'],
    });
    const monorepoBump = commit('monorepoBump', 2, {
      parentShas: [bump.sha],
      subject: 'chore(release): 2.0.2',
      files: ['packages/core/package.json'],
    });
    const dependency = commit('dependency', 3, {
      parentShas: [monorepoBump.sha],
      subject: 'feat: add the zod dependency',
      files: ['package.json'],
    });
    const commits = [dependency, monorepoBump, bump, root];

    const seeded = clusterSeedHistory(commits, commits).flatMap((cluster) =>
      cluster.commits.map((member) => member.sha)
    );
    expect(seeded).toContain(root.sha);
    expect(seeded).toContain(dependency.sha);
    expect(seeded).not.toContain(bump.sha);
    expect(seeded).not.toContain(monorepoBump.sha);
  });

  it('uses committer dates after rebases rather than original author chronology', () => {
    const a = commit('a', 0);
    const b = commit('b', 1, { parentShas: [a.sha] });
    expect(clusterSeedHistory([b, a], [b, a])).toHaveLength(1);
  });

  it('splits over-cap runs at the largest gap and folds mega-clusters by UTC day', () => {
    const commits = Array.from({ length: 51 }, (_, index) =>
      commit(`c${String(index).padStart(2, '0')}`, index, {
        parentShas: index === 0 ? [] : [`c${String(index - 1).padStart(2, '0')}`.padEnd(40, '0')],
        committerDateIso: new Date(Date.UTC(2025, 0, 1, 0, index * 10)).toISOString(),
      })
    );
    commits[7]!.committerDateIso = new Date(Date.UTC(2025, 0, 1, 2)).toISOString();
    for (let index = 8; index < commits.length; index++) {
      commits[index]!.committerDateIso = new Date(
        Date.UTC(2025, 0, 1, 2, (index - 7) * 10)
      ).toISOString();
    }

    const split = clusterSeedHistory([...commits].reverse(), commits, { runCap: 12 });
    expect(split.every((cluster) => cluster.commits.length <= 12)).toBe(true);
    expect(split[0]?.commits).toHaveLength(7);

    const foldCommits = Array.from({ length: 51 }, (_, index) =>
      commit(`f${String(index).padStart(2, '0')}`, index, {
        parentShas: index === 0 ? [] : [`f${String(index - 1).padStart(2, '0')}`.padEnd(40, '0')],
        committerDateIso: new Date(Date.UTC(2025, 0, 1, 0, index * 30)).toISOString(),
      })
    );
    const folded = clusterSeedHistory([...foldCommits].reverse(), foldCommits, { runCap: 100 });
    expect(folded).toHaveLength(1);
    expect(folded[0]?.checkpoints.length).toBeGreaterThan(1);
    expect(folded[0]?.checkpoints.every((checkpoint) => checkpoint.commits.length > 1)).toBe(true);
  });

  it('drops old members from long-lived merge branches and records the warning', () => {
    const root = commit('root', 0);
    const main = commit('main', 1, { parentShas: [root.sha] });
    const old = commit('old-side', 2, {
      parentShas: [root.sha],
      committerDateIso: '2024-01-01T00:00:00.000Z',
    });
    const recent = commit('recent-side', 3, {
      parentShas: [old.sha],
      committerDateIso: '2025-02-15T00:00:00.000Z',
    });
    const merge = commit('merge', 4, {
      parentShas: [main.sha, recent.sha],
      committerDateIso: '2025-02-16T00:00:00.000Z',
    });

    const merged = clusterSeedHistory([merge, main, root], [merge, recent, old, main, root], {
      windowStartIso: '2025-01-01T00:00:00.000Z',
    }).find((cluster) => cluster.kind === 'merge');
    expect(merged?.commits.map((member) => member.sha)).toEqual([recent.sha]);
    expect(merged?.warnings).toEqual(['long-lived branch import']);
  });
});

describe('displaySubject', () => {
  it('unwraps a revert wrapper to a revert prefix on the verbatim inner subject', () => {
    expect(displaySubject('Revert "feat(seed): add coverage lanes"')).toBe(
      'revert: feat(seed): add coverage lanes'
    );
  });

  it('unwraps nested revert-of-revert to a reapply prefix', () => {
    expect(displaySubject('Revert "Revert "feat(seed): add coverage lanes""')).toBe(
      'reapply: feat(seed): add coverage lanes'
    );
    expect(displaySubject('Reapply "feat(seed): add coverage lanes"')).toBe(
      'reapply: feat(seed): add coverage lanes'
    );
  });

  it('leaves unbalanced wrappers and plain subjects verbatim', () => {
    expect(displaySubject('Revert "feat: dangling')).toBe('Revert "feat: dangling');
    expect(displaySubject('feat: plain subject')).toBe('feat: plain subject');
  });
});
