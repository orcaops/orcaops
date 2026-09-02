import { realpathSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { artifactPathsFor, artifactsRoot, cacheDbPath, locksDir } from './paths.js';
import { type Config, getDefaultConfig } from '../schema/config.js';

describe('artifactPathsFor (flat layout)', () => {
  const repo = realpathSync(process.cwd());
  const config: Config = getDefaultConfig();
  const id = '01999999-9999-7000-8000-000000000001';

  it('routes the artifact directly under <artifacts.path>/<id>/ — no branch slug segment', () => {
    const paths = artifactPathsFor(repo, config, id);
    expect(paths.dir).toBe(path.join(repo, config.artifacts.path, id));
    expect(paths.dir.includes('main')).toBe(false);
  });

  it('emits the canonical projection paths under that directory', () => {
    const paths = artifactPathsFor(repo, config, id);
    const base = path.join(repo, config.artifacts.path, id);
    expect(paths.artifactJson).toBe(path.join(base, 'artifact.json'));
    expect(paths.eventsNdjson).toBe(path.join(base, 'events.ndjson'));
    expect(paths.sidecarsDir).toBe(path.join(base, 'sidecars'));
    expect(paths.planJson).toBe(path.join(base, 'plan.json'));
    expect(paths.planMd).toBe(path.join(base, 'plan.md'));
    expect(paths.summaryJson).toBe(path.join(base, 'summary.json'));
    expect(paths.summaryMd).toBe(path.join(base, 'summary.md'));
    expect(paths.evaluatorsJson).toBe(path.join(base, 'evaluators.json'));
    expect(paths.digestMd).toBe(path.join(base, 'digest.md'));
  });

  it('checkpoint paths are parameterized by n', () => {
    const paths = artifactPathsFor(repo, config, id);
    expect(paths.checkpointJson(7)).toMatch(/checkpoint-7\.json$/);
    expect(paths.checkpointMd(42)).toMatch(/checkpoint-42\.md$/);
  });

  it('artifactsRoot returns the parent directory (no per-id segment)', () => {
    expect(artifactsRoot(repo, config)).toBe(path.join(repo, config.artifacts.path));
  });

  it('cacheDbPath and locksDir resolve under .orcaops/', () => {
    expect(cacheDbPath(repo, config)).toBe(path.join(repo, config.cache.path));
    expect(locksDir(repo)).toBe(path.join(repo, '.orcaops', 'tmp', 'locks'));
  });

  it('two artifacts with different branches still land in distinct id-named dirs (no collision risk)', () => {
    const a = artifactPathsFor(repo, config, '01999999-9999-7000-8000-000000000001');
    const b = artifactPathsFor(repo, config, '01999999-9999-7000-8000-000000000002');
    expect(a.dir).not.toBe(b.dir);
  });
});
