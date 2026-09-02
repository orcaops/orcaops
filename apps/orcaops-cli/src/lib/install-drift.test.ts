import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { detectInstallIncompleteness } from './install-drift.js';
import { INSTALL_MANIFEST_REL, MANIFEST_VERSION } from './install-manifest.js';
import { CLOUD_GATED_SKILL_IDS, type SkillGates } from './skill-set.js';

const CLOUD: SkillGates = { cloud: true };
const NO_CLOUD: SkillGates = { cloud: false };

const CLOUD_PATHS = [...CLOUD_GATED_SKILL_IDS].map((id) => `.claude/skills/orcaops-${id}/SKILL.md`);
const UNGATED_PATH = '.claude/skills/orcaops-capture/SKILL.md';

async function repoWithManifest(entryPaths: string[]): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'orcaops-drift-'));
  await mkdir(path.join(root, '.orcaops'), { recursive: true });
  await writeFile(
    path.join(root, INSTALL_MANIFEST_REL),
    JSON.stringify({
      manifest_version: MANIFEST_VERSION,
      install_agents: ['claude-code'],
      naming_prefix: 'orcaops',
      entries: entryPaths.map((p) => ({ kind: 'generated-file', path: p })),
    })
  );
  return root;
}

describe('detectInstallIncompleteness', () => {
  it('reports an absent cloud skill to a machine that could materialize it', async () => {
    const root = await repoWithManifest(CLOUD_PATHS);
    expect(await detectInstallIncompleteness(root, CLOUD)).toMatchObject({
      missing: CLOUD_PATHS,
    });
  });

  it('stays silent when only gate-withheld files are absent', async () => {
    // The preservation deliberately keeps these entries in the committed
    // manifest on a machine that can never generate them, so counting them makes
    // the nudge permanent and its remedy — `orcaops update` — unable to clear it.
    // In CI that means re-running a full update on every bare invocation forever.
    const root = await repoWithManifest(CLOUD_PATHS);
    expect(await detectInstallIncompleteness(root, NO_CLOUD)).toBeNull();
  });

  it('still reports an absent ordinary skill without credentials', async () => {
    const root = await repoWithManifest([...CLOUD_PATHS, UNGATED_PATH]);
    expect(await detectInstallIncompleteness(root, NO_CLOUD)).toMatchObject({
      missing: [UNGATED_PATH],
    });
  });
});
