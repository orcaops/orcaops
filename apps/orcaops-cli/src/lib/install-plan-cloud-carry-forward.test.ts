import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { getToolAdapter } from '@orcaops/adapters';
import { getDefaultConfig, type SupportedAgentId } from '@orcaops/storage';

import {
  type InstallManifest,
  localEntryFromPlannedFile,
  type LocalManifest,
  MANIFEST_VERSION,
} from './install-manifest.js';
import { planInstallMutations } from './install-plan.js';
import { planOrphanPrune } from './install-prune.js';
import { CLOUD_GATED_SKILL_IDS, type SkillGates } from './skill-set.js';

const CLOUD: SkillGates = { cloud: true };
const NO_CLOUD: SkillGates = { cloud: false };
const PREFIX = 'orcaops';

const claude = getToolAdapter('claude-code')!;
const cloudSkillPaths = [...CLOUD_GATED_SKILL_IDS].map((id) => claude.skills!.filePath(id, PREFIX));

async function scratchRepo(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'orcaops-carry-'));
  await mkdir(path.join(root, '.orcaops'), { recursive: true });
  return root;
}

function configWithClaudeCode() {
  const config = getDefaultConfig();
  config.install.agents = ['claude-code'];
  return config;
}

function configWith(agents: SupportedAgentId[], prefix = PREFIX) {
  const config = getDefaultConfig();
  config.install.agents = agents;
  config.naming.prefix = prefix;
  return config;
}

async function planAgents(
  repoRoot: string,
  agents: SupportedAgentId[],
  gates: SkillGates,
  prevInstall: InstallManifest | null,
  prefix = PREFIX
) {
  return planInstallMutations({
    repoRoot,
    agents,
    scope: 'project',
    config: configWith(agents, prefix),
    gates,
    generatedBy: '9.9.9',
    gitignoreLines: [],
    prevInstall,
    prevLocal: null,
  });
}

/**
 * The prune's hash guard only reaches its delete branch when the local manifest
 * carries an `expectedHash` matching the bytes on disk. Without this the
 * entries classify as unverifiable and are preserved regardless, making the
 * assertions below pass vacuously.
 */
async function materializeInstall(
  repoRoot: string,
  plan: Awaited<ReturnType<typeof planInstallMutations>>
): Promise<LocalManifest> {
  for (const pf of plan.genFiles) {
    await mkdir(path.join(repoRoot, path.dirname(pf.path)), { recursive: true });
    await writeFile(path.join(repoRoot, pf.path), pf.desiredContent);
  }
  return {
    manifest_version: MANIFEST_VERSION,
    entries: plan.genFiles.map(localEntryFromPlannedFile),
  };
}

async function planWith(repoRoot: string, gates: SkillGates, prevInstall: InstallManifest | null) {
  return planInstallMutations({
    repoRoot,
    agents: ['claude-code'],
    scope: 'project',
    config: configWithClaudeCode(),
    gates,
    generatedBy: '9.9.9',
    gitignoreLines: [],
    prevInstall,
    prevLocal: null,
  });
}

describe('cloud-skill carry-forward (the gate blocks creation, never deletion)', () => {
  it('plans the cloud skills into the manifest WITH a session', async () => {
    const plan = await planWith(await scratchRepo(), CLOUD, null);
    const paths = plan.install.entries.map((e) => e.path);
    for (const rel of cloudSkillPaths) expect(paths).toContain(rel);
  });

  it('omits them from a FRESH install without a session', async () => {
    const plan = await planWith(await scratchRepo(), NO_CLOUD, null);
    const paths = plan.install.entries.map((e) => e.path);
    for (const rel of cloudSkillPaths) expect(paths).not.toContain(rel);
  });

  it('carries a prior install forward untouched without a session', async () => {
    const repoRoot = await scratchRepo();
    const withCloud = await planWith(repoRoot, CLOUD, null);
    const withoutCloud = await planWith(repoRoot, NO_CLOUD, withCloud.install);
    expect(JSON.stringify(withoutCloud.install)).toBe(JSON.stringify(withCloud.install));
  });

  it('leaves the orphan prune with nothing to delete', async () => {
    const repoRoot = await scratchRepo();
    const withCloud = await planWith(repoRoot, CLOUD, null);
    const prevLocal = await materializeInstall(repoRoot, withCloud);

    const withoutCloud = await planWith(repoRoot, NO_CLOUD, withCloud.install);
    const prune = await planOrphanPrune({
      repoRoot,
      prefix: PREFIX,
      prevInstall: withCloud.install,
      nextInstall: withoutCloud.install,
      prevLocal,
      genFiles: withoutCloud.genFiles,
      currentVersion: '9.9.9',
    });
    for (const rel of cloudSkillPaths) expect(prune.deleted).not.toContain(rel);
  });

  it('restores the planner ordering rather than appending', async () => {
    const repoRoot = await scratchRepo();
    const withCloud = await planWith(repoRoot, CLOUD, null);
    const withoutCloud = await planWith(repoRoot, NO_CLOUD, withCloud.install);
    expect(withoutCloud.install.entries.map((e) => `${e.kind} ${e.path}`)).toEqual(
      withCloud.install.entries.map((e) => `${e.kind} ${e.path}`)
    );
  });

  it('keeps the planner ordering when more than one adapter ships commands', async () => {
    // A skills-only ordering key ranks every command equal, hoisting them behind
    // the skills. Single-adapter repos cannot catch it — claude-code's commands
    // already sort last.
    const repoRoot = await scratchRepo();
    const agents: SupportedAgentId[] = ['claude-code', 'cursor'];
    const withCloud = await planAgents(repoRoot, agents, CLOUD, null);
    const withoutCloud = await planAgents(repoRoot, agents, NO_CLOUD, withCloud.install);
    expect(withoutCloud.install.entries.map((e) => `${e.kind} ${e.path}`)).toEqual(
      withCloud.install.entries.map((e) => `${e.kind} ${e.path}`)
    );
  });

  it('preserves the old-prefix cloud skills through a rename without a session', async () => {
    const repoRoot = await scratchRepo();
    const withCloud = await planAgents(repoRoot, ['claude-code'], CLOUD, null, 'orcaops');
    const renamed = await planAgents(repoRoot, ['claude-code'], NO_CLOUD, withCloud.install, 'oo');
    const paths = renamed.install.entries.map((e) => e.path);

    // The gate cannot re-create them, so dropping the entries hands them to the
    // prune with a passing hash guard.
    for (const rel of cloudSkillPaths) expect(paths).toContain(rel);

    // …in the slot its current-prefix equivalent holds, so the next credentialed
    // run does not reorder the manifest again.
    const generated = renamed.install.entries
      .filter((e) => e.kind === 'generated-file')
      .map((e) => e.path);
    const cloudIdx = generated.flatMap((rel, i) => (cloudSkillPaths.includes(rel) ? [i] : []));
    const otherIdx = generated.flatMap((rel, i) => (cloudSkillPaths.includes(rel) ? [] : [i]));
    expect(Math.min(...cloudIdx)).toBeLessThan(Math.max(...otherIdx));
    // Everything else renames normally.
    expect(paths).toContain('.claude/skills/oo-digest/SKILL.md');
    expect(paths).not.toContain('.claude/skills/orcaops-digest/SKILL.md');
  });

  it('still preserves the old-prefix entries after the rename is recorded', async () => {
    // The first post-rename run reads the old prefix from prevInstall.
    // naming_prefix; that run rewrites it, so every later run can name the old
    // paths only through the entries themselves.
    const repoRoot = await scratchRepo();
    const withCloud = await planAgents(repoRoot, ['claude-code'], CLOUD, null, 'orcaops');
    const first = await planAgents(repoRoot, ['claude-code'], NO_CLOUD, withCloud.install, 'oo');
    const second = await planAgents(repoRoot, ['claude-code'], NO_CLOUD, first.install, 'oo');

    const paths = second.install.entries.map((e) => e.path);
    for (const rel of cloudSkillPaths) expect(paths).toContain(rel);
    expect(JSON.stringify(second.install)).toBe(JSON.stringify(first.install));
  });

  it('preserves a lone old-prefix cloud entry after the rename is recorded', async () => {
    // A pre-review-era manifest can hold ONE cloud skill under a renamed-away
    // prefix. The entry is the only record of ownership, so it must survive
    // and the prune must have nothing to delete.
    const repoRoot = await scratchRepo();
    const withCloud = await planAgents(repoRoot, ['claude-code'], CLOUD, null, 'orcaops');
    const prevLocal = await materializeInstall(repoRoot, withCloud);
    const renamed = await planAgents(repoRoot, ['claude-code'], NO_CLOUD, withCloud.install, 'oo');
    const lone: InstallManifest = {
      ...renamed.install,
      entries: renamed.install.entries.filter((e) => !e.path.includes('orcaops-review/SKILL.md')),
    };

    const next = await planAgents(repoRoot, ['claude-code'], NO_CLOUD, lone, 'oo');
    const paths = next.install.entries.map((e) => e.path);
    expect(paths).toContain('.claude/skills/orcaops-plan-approval/SKILL.md');

    const prune = await planOrphanPrune({
      repoRoot,
      prefix: 'oo',
      prevInstall: lone,
      nextInstall: next.install,
      prevLocal,
      genFiles: next.genFiles,
      currentVersion: '9.9.9',
    });
    expect(prune.deleted).not.toContain('.claude/skills/orcaops-plan-approval/SKILL.md');
  });

  it('does not read a longer template id as a prefixed cloud skill', async () => {
    // `orcaops-task-review` is task-review under the old prefix — an ordinary
    // orphan — not prefix "orcaops-task" + cloud "review".
    const repoRoot = await scratchRepo();
    const withCloud = await planAgents(repoRoot, ['claude-code'], CLOUD, null, 'orcaops');
    const renamed = await planAgents(repoRoot, ['claude-code'], NO_CLOUD, withCloud.install, 'oo');
    const doctored: InstallManifest = {
      ...renamed.install,
      entries: [
        ...renamed.install.entries,
        { kind: 'generated-file', path: '.claude/skills/orcaops-task-review/SKILL.md' },
      ],
    };
    const next = await planAgents(repoRoot, ['claude-code'], NO_CLOUD, doctored, 'oo');

    const paths = next.install.entries.map((e) => e.path);
    expect(paths).not.toContain('.claude/skills/orcaops-task-review/SKILL.md');
    for (const rel of cloudSkillPaths) expect(paths).toContain(rel);
  });

  it('records every preserved entry in BOTH manifests', async () => {
    // Ownership without evidence: the delete guard reads install.local.json, so
    // an entry missing there is preserved as unverifiable forever.
    const repoRoot = await scratchRepo();
    const withCloud = await planAgents(repoRoot, ['claude-code'], CLOUD, null);
    await materializeInstall(repoRoot, withCloud);
    const withoutCloud = await planAgents(repoRoot, ['claude-code'], NO_CLOUD, withCloud.install);

    const installGenerated = withoutCloud.install.entries
      .filter((e) => e.kind === 'generated-file')
      .map((e) => e.path);
    const localGenerated = withoutCloud.local.entries
      .filter((e) => e.kind === 'generated-file')
      .map((e) => e.path);
    expect(localGenerated).toEqual(installGenerated);
    for (const rel of cloudSkillPaths) expect(localGenerated).toContain(rel);
  });

  it('still prunes a non-cloud skill the user disabled', async () => {
    // Keyed on what the GATE withholds, so an ordinary removal stays removable.
    const repoRoot = await scratchRepo();
    const withCloud = await planAgents(repoRoot, ['claude-code'], CLOUD, null);

    const config = configWith(['claude-code']);
    config.skills.enabled = { digest: false };
    const withoutDigest = await planInstallMutations({
      repoRoot,
      agents: ['claude-code'],
      scope: 'project',
      config,
      gates: NO_CLOUD,
      generatedBy: '9.9.9',
      gitignoreLines: [],
      prevInstall: withCloud.install,
      prevLocal: null,
    });
    expect(withoutDigest.install.entries.map((e) => e.path)).not.toContain(
      '.claude/skills/orcaops-digest/SKILL.md'
    );
  });

  it('does not invent entries a prior install never had', async () => {
    const repoRoot = await scratchRepo();
    const emptyPrev: InstallManifest = {
      manifest_version: MANIFEST_VERSION,
      install_agents: ['claude-code'],
      naming_prefix: PREFIX,
      entries: [],
    };
    const plan = await planWith(repoRoot, NO_CLOUD, emptyPrev);
    const paths = plan.install.entries.map((e) => e.path);
    for (const rel of cloudSkillPaths) expect(paths).not.toContain(rel);
  });
});
