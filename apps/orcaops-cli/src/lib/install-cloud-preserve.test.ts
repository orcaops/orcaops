import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { getToolAdapter, type ToolAdapter } from '@orcaops/adapters';
import { getDefaultConfig, resolveConfig } from '@orcaops/storage';

import { resolveCloudPreservation } from './install-cloud-preserve.js';
import {
  type InstallManifest,
  type LocalEntry,
  type LocalManifest,
  MANIFEST_VERSION,
} from './install-manifest.js';
import { CLOUD_GATED_SKILL_IDS, type SkillGates } from './skill-set.js';

const CLOUD: SkillGates = { cloud: true };
const NO_CLOUD: SkillGates = { cloud: false };
const VERSION = '9.9.9';

const claude = getToolAdapter('claude-code')!;
const [CLOUD_ID] = [...CLOUD_GATED_SKILL_IDS];
const CLOUD_REL = claude.skills!.filePath(CLOUD_ID!, 'orcaops');

async function scratchRepo(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'orcaops-preserve-'));
}

function prevInstallWith(paths: string[], namingPrefix = 'orcaops'): InstallManifest {
  return {
    manifest_version: MANIFEST_VERSION,
    install_agents: ['claude-code'],
    naming_prefix: namingPrefix,
    entries: paths.map((p) => ({ kind: 'generated-file' as const, path: p })),
  };
}

function resolve(over: Partial<Parameters<typeof resolveCloudPreservation>[0]> = {}) {
  return resolveCloudPreservation({
    repoRoot: '/nonexistent',
    adapters: [claude],
    config: getDefaultConfig(),
    gates: NO_CLOUD,
    scope: 'project',
    currentVersion: VERSION,
    genFiles: [],
    prevInstall: prevInstallWith([CLOUD_REL]),
    prevLocal: null,
    ...over,
  });
}

describe('resolveCloudPreservation', () => {
  it('preserves nothing when the machine holds credentials', async () => {
    expect(await resolve({ gates: CLOUD })).toBeNull();
  });

  it('preserves nothing on a fresh install with no prior manifest', async () => {
    expect(await resolve({ prevInstall: null })).toBeNull();
  });

  it.each(['global', 'personal'] as const)(
    'preserves nothing under %s scope, which owns no project files',
    async (scope) => {
      expect(await resolve({ scope })).toBeNull();
    }
  );

  it('ignores a prior entry the gate is not withholding', async () => {
    // An ordinary orphan the prune must stay free to remove.
    expect(
      await resolve({ prevInstall: prevInstallWith(['.claude/skills/orcaops-why/SKILL.md']) })
    ).toBeNull();
  });

  it('ignores a cloud skill the user explicitly disabled', async () => {
    const config = resolveConfig({ skills: { enabled: { [CLOUD_ID!]: false } } });
    const preserved = await resolve({ config });
    expect(preserved?.files.map((f) => f.path) ?? []).not.toContain(CLOUD_REL);
  });

  it('matches a slash-spelled manifest entry against a backslash file path', async () => {
    // A separator path never matches a slash-canonical manifest entry, and a
    // preservation rule that never matches fails OPEN: the prune deletes.
    const windowsish: ToolAdapter = {
      ...claude,
      skills: {
        ...claude.skills!,
        filePath: (id, prefix) => claude.skills!.filePath(id, prefix).replaceAll('/', '\\'),
      },
    };
    const preserved = await resolve({ adapters: [windowsish], repoRoot: await scratchRepo() });
    expect(preserved?.files.map((f) => f.path)).toEqual([CLOUD_REL]);
  });

  it('matches an old-prefix entry after a rename', async () => {
    const config = getDefaultConfig();
    config.naming.prefix = 'oo';
    const preserved = await resolve({
      config,
      prevInstall: prevInstallWith([CLOUD_REL]),
      repoRoot: await scratchRepo(),
    });
    expect(preserved?.files.map((f) => f.path)).toEqual([CLOUD_REL]);
  });

  describe('the delete guard for a preserved entry', () => {
    it('is carried from the prior local manifest verbatim when there is one', async () => {
      const carried: LocalEntry = {
        kind: 'generated-file',
        path: CLOUD_REL,
        expectedHash: 'deadbeef',
        provenance: 'created',
        deleteMode: 'hash',
      };
      const prevLocal: LocalManifest = { manifest_version: MANIFEST_VERSION, entries: [carried] };
      const preserved = await resolve({ prevLocal });
      // Identity, not equality: the prior run materialized these bytes.
      expect(preserved!.files[0]!.local).toBe(carried);
    });

    it('is unverifiable-but-inspectable when the file is absent', async () => {
      const preserved = await resolve({ repoRoot: await scratchRepo() });
      expect(preserved!.files[0]!.local).toMatchObject({
        expectedHash: null,
        deleteMode: 'confirm',
      });
    });

    it('is a hash guard when the file on disk is the current render', async () => {
      const repoRoot = await scratchRepo();
      const desired = claude.skills!.format(
        // The registry template for the gated id, rendered at the current stamp.
        (await import('@orcaops/adapters')).SKILL_TEMPLATES.find((t) => t.id === CLOUD_ID)!,
        { generatedBy: VERSION, prefix: 'orcaops' }
      );
      await mkdir(path.join(repoRoot, path.dirname(CLOUD_REL)), { recursive: true });
      await writeFile(path.join(repoRoot, CLOUD_REL), desired);

      const preserved = await resolve({ repoRoot });
      // Clean and owned, so `uninstall` can remove it.
      expect(preserved!.files[0]!.local).toMatchObject({
        provenance: 'created',
        deleteMode: 'hash',
      });
    });

    it('never deletes a file a user edited', async () => {
      const repoRoot = await scratchRepo();
      await mkdir(path.join(repoRoot, path.dirname(CLOUD_REL)), { recursive: true });
      await writeFile(path.join(repoRoot, CLOUD_REL), 'hand-written, no stamp\n');

      const preserved = await resolve({ repoRoot });
      expect(preserved!.files[0]!.local).toMatchObject({
        provenance: 'pre-existing',
        deleteMode: 'never',
      });
    });
  });
});
