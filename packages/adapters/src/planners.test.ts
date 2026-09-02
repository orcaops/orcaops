import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { planInjectOrcaopsSection } from './agents-md/inject.js';
import { renderOrcaopsAgentsMdSection } from './agents-md/template.js';
import { planGenerateForTool } from './generator.js';
import { claudeCodeAdapter } from './tools/claude-code.js';

describe('planners are pure (write nothing to disk)', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'oo-plan-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('planGenerateForTool reports create actions on an empty repo and writes nothing', async () => {
    const plan = await planGenerateForTool({
      repoRoot: root,
      adapter: claudeCodeAdapter,
      generatedBy: '0.0.0',
    });
    expect(plan.files).toHaveLength(34);
    expect(plan.files.every((f) => f.action === 'create')).toBe(true);
    expect(plan.files.every((f) => f.currentContent === null)).toBe(true);
    expect(plan.files.every((f) => /^[0-9a-f]{64}$/.test(f.hash))).toBe(true);
    // The whole point: planning touched no disk.
    await expect(readdir(root)).resolves.toEqual([]);
  });

  it('planInjectOrcaopsSection plans create then unchanged, writing nothing during planning', async () => {
    const filePath = path.join(root, 'AGENTS.md');
    const p1 = await planInjectOrcaopsSection({
      desiredBlock: renderOrcaopsAgentsMdSection({ generatedBy: '0.0.0' }),
      filePath,
      containmentRoot: root,
    });
    expect(p1.action).toBe('created');
    expect(p1.currentContent).toBeNull();
    expect(/^[0-9a-f]{64}$/.test(p1.blockHash)).toBe(true);
    await expect(readdir(root)).resolves.toEqual([]); // nothing written by planning

    // Materialize the desired block, then re-plan: now it's a no-op.
    await writeFile(filePath, p1.desiredContent, 'utf8');
    const p2 = await planInjectOrcaopsSection({
      desiredBlock: renderOrcaopsAgentsMdSection({ generatedBy: '0.0.0' }),
      filePath,
      containmentRoot: root,
    });
    expect(p2.action).toBe('unchanged');
    expect(p2.desiredContent).toBe(p1.desiredContent);
  });
});
