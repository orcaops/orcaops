// GUARD: the managed block committed to THIS repo must be what the current
// template renders.
//
// orcaops dogfoods itself — CLAUDE.md carries an orcaops-managed block, and
// `generated_files=commit` puts it in git. So the block is a generated
// artifact a template change can strand: body drift at an unchanged version
// is invisible to the stamp check, leaving the repo advertising a block its
// own renderer no longer produces.
//
// `canonical-disk-parity.test.ts` guards exactly this property for SKILL.md
// files and its header even names the hole — "the block-staleness check
// compares only the version STAMP, not the body, so a prose change at the
// same version is not auto-detected" — but stops short of the block itself.
// This closes that half.
//
// Lives at the CLI level rather than in packages/adapters because rendering the
// repo's own block needs the naming prefix and workflow hints out of
// .orcaops/config.json, which the adapters package has no business loading.

import { lstat, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  planInjectOrcaopsSection,
  renderOrcaopsAgentsMdSection,
  resolveHintLines,
} from '@orcaops/adapters';
import { loadConfig } from '@orcaops/core';

import { resolveManagedInstructionFiles } from '../../src/lib/install-drift.js';
import { enabledSkillTemplates } from '../../src/lib/skill-set.js';

const require = createRequire(import.meta.url);
const cliPkg = require('../../package.json') as { version: string };

/** apps/orcaops-cli/tests/integration → repo root */
const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..'
);

describe("this repo's committed instruction block matches the current template", () => {
  it('`orcaops update` would not rewrite the committed block', async () => {
    const config = await loadConfig(REPO_ROOT, { allowMissing: false });

    // Under manual bootstrap the inverse invariant applies: no stranded
    // managed block may remain to advertise a renderer that no longer owns
    // the file.
    if (config.bootstrap === 'manual') {
      for (const rel of ['CLAUDE.md', 'AGENTS.md']) {
        const text = await readFile(path.join(REPO_ROOT, rel), 'utf8').catch(() => '');
        expect(text, rel).not.toContain('orcaops:start');
      }
      return;
    }

    expect(config.bootstrap).toBe('managed');

    const desiredBlock = renderOrcaopsAgentsMdSection({
      generatedBy: cliPkg.version,
      prefix: config.naming.prefix,
      hints: resolveHintLines(config.workflow.hints),
      enabledSkills: enabledSkillTemplates(config, { cloud: false }),
    });

    const files = resolveManagedInstructionFiles(config);
    expect(files.length).toBeGreaterThan(0);

    const drifted: string[] = [];
    let compared = 0;
    for (const rel of files) {
      const abs = path.join(REPO_ROOT, rel);
      let stats;
      try {
        stats = await lstat(abs);
      } catch {
        drifted.push(`${rel}: absent`);
        continue;
      }
      // AGENTS.md symlinks to the canonical CLAUDE.md. Reading through it would
      // compare the same bytes twice and report two failures for one file, so
      // real files only — the same rule planRemoveInstructionBlocks applies.
      if (stats.isSymbolicLink()) continue;

      compared++;
      const plan = await planInjectOrcaopsSection({
        filePath: abs,
        containmentRoot: REPO_ROOT,
        desiredBlock,
      });
      // Same comparison `update` makes before deciding to rewrite, so a green
      // guard means update is genuinely a no-op here — not merely that some
      // weaker equivalence held.
      if (plan.action !== 'unchanged') drifted.push(`${rel}: ${plan.action}`);
    }

    expect(compared).toBeGreaterThan(0);
    expect(drifted).toEqual([]);
  });
});
