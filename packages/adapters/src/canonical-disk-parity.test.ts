// DRIFT GUARD, both directions: the canonical skill renders and the files
// committed under `.claude/skills/` & `.agents/skills/` must describe the same
// set, with the same bytes.
//
// The skill bodies in this package are the source of truth; the checked-in files
// are generated from them. The block-staleness check compares only the version
// STAMP, not the body, so a prose change at the same version is not
// auto-detected.
//
// FORWARD — every canonical render matches disk. Catches an edited skill body
// that was never regenerated.
//
// REVERSE — every committed file resolves to a canonical template. Catches a
// template deleted from the registry whose generated files were left behind. It
// is stated as a one-way set difference on purpose:
//
//     fail on   disk \ canonical      (a file nothing generates)
//     permit    canonical \ disk      (a template nothing installed)
//
// That asymmetry IS the guarantee, not an oversight. Which skills materialize is
// config-gated and opt-in templates ship `defaultEnabled: false`, so some
// templates correctly render to no installed file; requiring the reverse
// containment would fail on them.
//
// Enforcing this direction is what stops a template deletion from stranding
// generated files.

import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { TOOL_ADAPTERS } from './registry.js';
import { SKILL_TEMPLATES } from './skills/index.js';

const REPO_ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');

/** The stamp is injectable, so parity is checked against what disk actually claims. */
const stampOf = (text: string): string => {
  const m = /generatedBy: "orcaops@([^"]+)"/.exec(text);
  return m?.[1] ?? '0.0.0';
};

/**
 * The whole reverse rule, isolated so it can be tested against a synthetic
 * orphan below. A guard nobody has watched fail is a guard nobody has tested.
 */
export const orphanedSkillFiles = (
  onDisk: readonly string[],
  canonical: ReadonlySet<string>
): string[] => onDisk.filter((file) => !canonical.has(file)).sort();

/**
 * Committed `orcaops-*` skill files under a root. Read from the git index
 * rather than walked: the defect being guarded is "deleted from the registry
 * but still COMMITTED", and the index keeps the test independent of whatever a
 * given machine happens to have installed locally.
 */
const trackedSkillFiles = (root: string): string[] =>
  execFileSync('git', ['ls-files', `${root}/orcaops-*/SKILL.md`], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  })
    .split('\n')
    .filter(Boolean);

describe('canonical skill renders match the committed files', () => {
  for (const adapter of TOOL_ADAPTERS) {
    if (adapter.skills === null) continue;

    it(`${adapter.id}: every canonical skill render is byte-identical to disk`, async () => {
      const drifted: string[] = [];
      let compared = 0;
      let notInstalled = 0;

      for (const skill of SKILL_TEMPLATES) {
        const rel = adapter.skills!.filePath(skill.id, 'orcaops');
        let onDisk: string;
        try {
          onDisk = await readFile(path.join(REPO_ROOT, rel), 'utf8');
        } catch {
          // NOT drift: which skills materialize is config-gated (some appear
          // only when a feature is enabled), and not every adapter is installed
          // in this repo. Counted, not failed — conflating "absent" with
          // "stale" would make this test fail for reasons it cannot fix.
          notInstalled += 1;
          continue;
        }
        compared += 1;
        const rendered = adapter.skills!.format(skill, { generatedBy: stampOf(onDisk) });
        if (rendered !== onDisk) drifted.push(rel);
      }

      // An adapter with nothing installed here has nothing to protect.
      if (compared === 0) {
        expect(notInstalled).toBeGreaterThan(0);
        return;
      }
      // Guards the guard: a filePath change that silently compared almost
      // nothing would otherwise pass this test trivially.
      expect(compared, `${adapter.id} compared suspiciously few skills`).toBeGreaterThan(5);
      expect(drifted, 'canonical bodies changed — regenerate and commit the skill files').toEqual(
        []
      );
    });
  }
});

describe('every committed skill file resolves to a canonical template', () => {
  // Grouped by ROOT rather than by adapter: codex, cursor, opencode,
  // github-copilot, and antigravity-cli all render into `.agents/skills`, so per-adapter iteration
  // would check the same directory four times and report an orphan four times.
  const canonicalByRoot = new Map<string, Set<string>>();
  for (const adapter of TOOL_ADAPTERS) {
    if (adapter.skills === null) continue;
    for (const skill of SKILL_TEMPLATES) {
      const rel = adapter.skills.filePath(skill.id, 'orcaops');
      const root = path.dirname(path.dirname(rel));
      let set = canonicalByRoot.get(root);
      if (set === undefined) {
        set = new Set<string>();
        canonicalByRoot.set(root, set);
      }
      set.add(rel);
    }
  }

  it('the roots under test were actually discovered', () => {
    // Without this, a filePath refactor that produced no roots would leave the
    // loop below generating zero tests — a silent pass.
    expect(canonicalByRoot.size).toBeGreaterThan(0);
    expect([...canonicalByRoot.keys()]).toContain('.claude/skills');
  });

  for (const [root, canonical] of canonicalByRoot) {
    it(`${root}: no committed file is left behind by a deleted template`, () => {
      const onDisk = trackedSkillFiles(root);

      // A root with nothing committed means that adapter is not installed in
      // this repo — the same "absent is not drift" rule the forward direction
      // uses. Nothing to strand, nothing to check.
      if (onDisk.length === 0) return;

      // Guards the guard: a broken ls-files pattern returns an empty disk set,
      // which makes the difference below trivially empty and the test green
      // while it is checking nothing at all.
      expect(onDisk.length, `${root} discovered suspiciously few committed skills`).toBeGreaterThan(
        5
      );

      expect(
        orphanedSkillFiles(onDisk, canonical),
        `${root}: committed skill file(s) with no canonical template — a template was deleted from the registry and its generated files were left behind. Delete them, or restore the template.`
      ).toEqual([]);
    });
  }

  it('permits a canonical template that is not installed', () => {
    // The asymmetry, asserted rather than assumed: opt-in and capability-gated
    // skills legitimately render to nothing on disk. If this ever reads 0 the
    // test above has stopped being a one-way check and would start failing on
    // skills that are correctly absent.
    const canonical = canonicalByRoot.get('.claude/skills')!;
    const onDisk = new Set(trackedSkillFiles('.claude/skills'));
    const notInstalled = [...canonical].filter((file) => !onDisk.has(file));
    expect(notInstalled.length).toBeGreaterThan(0);
    expect(orphanedSkillFiles([...onDisk], canonical)).toEqual([]);
  });

  it('DETECTS a synthetic orphan — proving the rule can fail', () => {
    // The reverse direction currently passes because the tree is clean, which
    // is indistinguishable from a rule that cannot fire. This distinguishes it.
    const canonical = new Set([
      '.claude/skills/orcaops-capture/SKILL.md',
      '.claude/skills/orcaops-why/SKILL.md',
    ]);
    const withOrphan = [
      '.claude/skills/orcaops-capture/SKILL.md',
      '.claude/skills/orcaops-standup/SKILL.md', // deleted from the registry
      '.claude/skills/orcaops-why/SKILL.md',
    ];
    expect(orphanedSkillFiles(withOrphan, canonical)).toEqual([
      '.claude/skills/orcaops-standup/SKILL.md',
    ]);
    // And stays silent on the permitted direction.
    expect(orphanedSkillFiles(['.claude/skills/orcaops-capture/SKILL.md'], canonical)).toEqual([]);
  });
});
