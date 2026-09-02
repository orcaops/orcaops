import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

import { getPack, listPacks } from './index.js';

/**
 * The package ships three first-party packs today (`core`, `js`,
 * `demo`). The tests assert the module API enumerates them and
 * resolves each to an absolute path. Each pack_root must point
 * at a directory containing a `package.yaml` so the resolver in
 * @orcaops/evaluator-runner can `loadPackage(pack_root)` against
 * the returned path.
 */
describe('@orcaops/evaluator-pack module API', () => {
  const EXPECTED_FIRST_PARTY_PACKS = ['core', 'demo', 'js'];

  it('listPacks returns every shipped first-party pack', () => {
    const packs = listPacks();
    const ids = packs.map((p) => p.id).sort();
    for (const expected of EXPECTED_FIRST_PARTY_PACKS) {
      expect(ids).toContain(expected);
    }
  });

  it('listPacks resolves pack_root to an absolute path containing package.yaml', async () => {
    const { existsSync } = await import('node:fs');
    const path = await import('node:path');
    for (const pack of listPacks()) {
      expect(path.isAbsolute(pack.pack_root)).toBe(true);
      expect(existsSync(path.join(pack.pack_root, 'package.yaml'))).toBe(true);
    }
  });

  it('getPack(id) returns the matching ref', () => {
    const core = getPack('core');
    expect(core).not.toBeNull();
    expect(core!.id).toBe('core');
    expect(core!.pack_root).toMatch(/packs\/core$/);
  });

  it('getPack returns null for an unknown pack id', () => {
    expect(getPack('not-a-pack')).toBeNull();
  });

  it('marks demo as explicit example content rather than a default pack', async () => {
    const { readFile } = await import('node:fs/promises');
    const path = await import('node:path');
    const demo = getPack('demo');
    expect(demo).not.toBeNull();

    const raw = await readFile(path.join(demo!.pack_root, 'package.yaml'), 'utf8');
    const manifest = parseYaml(raw) as { description: string };
    expect(manifest.description).toContain('Explicitly installed example content');
    expect(manifest.description).toContain('never installs this pack by default');
    expect(manifest.description).toContain('unsuitable for normal production workflows');
    expect(manifest.description).not.toContain('non-empty out of the box');
  });
});
