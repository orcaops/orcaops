// Who may answer "what stands?" — and it is not a surface.
//
// Standing, applicability and which correction is current are decided once, in the resolver and
// storage's read and publication boundaries. A surface that imports one has begun deciding them
// itself, and two surfaces deciding separately is how one identity comes to have two answers. This
// fails the moment any other module reaches for one.
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../../../..', import.meta.url));

/** Every function that answers what stands, or hands out an answer that does. */
const RESOLVERS = [
  'resolveKnowledge',
  'governingStateOf',
  'readProjectGoverningState',
  'governingStateReader',
  'revisionGoverningState',
];

/**
 * The modules that may import one, and why each may.
 *
 * Every other module — every CLI surface, Watch, the review engine, core — reaches standing only
 * through `projectKnowledgeContext` and the shape core builds from it.
 */
const ALLOWED: ReadonlyArray<{ file: string; because: string }> = [
  {
    file: 'packages/storage/src/schema/knowledge-resolution.ts',
    because: 'The resolver itself: it defines resolveKnowledge and governingStateOf.',
  },
  {
    file: 'packages/storage/src/history/database/knowledge-read-boundary.ts',
    because: 'Defines revisionGoverningState, which reads one revision out of a resolved answer.',
  },
  {
    file: 'packages/storage/src/history/database/knowledge-read-governing.ts',
    because:
      'The one reader that resolves a project target, and the shared reader every other read passes around.',
  },
  {
    file: 'packages/storage/src/history/database/knowledge-context.ts',
    because: 'The composer: one read, one boundary, one answer, which every surface consumes.',
  },
  {
    file: 'packages/storage/src/history/database/knowledge-retrieval.ts',
    because: 'Bounded retrieval, which finds candidates for the composer under its own bounds.',
  },
  {
    file: 'packages/storage/src/history/database/knowledge-read-lineage.ts',
    because:
      'A reader the composer composes: the revisions visible at the boundary and their tips.',
  },
  {
    file: 'packages/storage/src/history/database/knowledge-read-task-uses.ts',
    because: "A reader the composer composes: a plan event's uses and what became of each target.",
  },
  {
    file: 'packages/storage/src/history/database/knowledge-read-bindings.ts',
    because: 'A reader of the same family: what an approval or a binding named, at a boundary.',
  },
  {
    file: 'packages/storage/src/history/database/knowledge-standing.ts',
    because:
      'The writer-side preview of what a correction would change. It resolves before and after an act, not for a reader.',
  },
  {
    file: 'packages/storage/src/history/database/knowledge-act-effects.ts',
    because:
      'The publication gate reads whether an act still has an effect, using the shared resolver inside the same transaction.',
  },
  {
    file: 'packages/storage/src/history/database/index.ts',
    because:
      'The barrel that re-exports `revisionGoverningState`, `governingStateReader` and ' +
      '`readProjectGoverningState` for the modules above; it calls none of them.',
  },
  {
    file: 'packages/storage/src/schema/index.ts',
    because: 'The schema barrel, which re-exports the resolver module whole; it calls nothing.',
  },
];

const SKIPPED_DIRECTORIES = new Set(['node_modules', 'dist', '.git', 'coverage', 'fixtures']);

/**
 * Test code, which may name a resolver: asserting what one answers is how the resolver is verified
 * at all, and a test is not a surface anyone reads an answer from. A fixture a test imports is the
 * same code by another file name — `.test-support.ts`, or anything under a workspace's `tests/`
 * directory, which holds only the harnesses and helpers its tests run through.
 */
const isTestCode = (relative: string): boolean =>
  /\.test(?:-support)?\.tsx?$/u.test(relative) || relative.split(path.sep).includes('tests');

async function sourceFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) await walk(absolute);
        continue;
      }
      if (!entry.name.endsWith('.ts') && !entry.name.endsWith('.tsx')) continue;
      const relative = path.relative(root, absolute);
      if (isTestCode(relative)) continue;
      found.push(relative);
    }
  };
  for (const workspace of ['packages', 'apps']) await walk(path.join(root, workspace));
  return found.sort();
}

const NAMED_BLOCK = /(?:import|export)\s+(?:type\s+)?\{([\s\S]*?)\}\s*from\s*'([^']+)'/gu;
const WHOLE_MODULE =
  /(?:import\s+(?:type\s+)?\*\s+as\s+\w+|export\s+\*(?:\s+as\s+\w+)?)\s+from\s*'([^']+)'/gu;

/**
 * The resolver names a file takes from another module, whether it keeps them or hands them on.
 * Both forms are counted: a module that re-exports a resolver puts it within reach of every file
 * that imports the module, which is exactly what this guard is about.
 */
function namedFromModules(body: string): string[] {
  const names: string[] = [];
  for (const match of body.matchAll(NAMED_BLOCK))
    for (const binding of match[1]!.split(','))
      names.push(
        binding
          .trim()
          .replace(/^type\s+/u, '')
          .split(/\s+as\s+/u)[0]!
          .trim()
      );
  return names;
}

/**
 * A module that hands out a resolver whole rather than by name: the three that define one, and the
 * barrels that re-export them. `import * as store from '@orcaops/storage/history/database'` reaches
 * every resolver the barrel carries without naming one, which the per-name check cannot see, and
 * `export * from './knowledge-resolution.js'` passes them on the same way.
 */
const RESOLVER_MODULES = [
  'knowledge-resolution',
  'knowledge-read-governing',
  'knowledge-read-boundary',
  '@orcaops/storage',
];

describe('who may resolve what stands', () => {
  it('is the resolver and its declared storage boundaries, and nothing else', async () => {
    const allowed = new Set(ALLOWED.map((entry) => entry.file));
    const offenders: string[] = [];
    for (const file of await sourceFiles(repoRoot)) {
      if (allowed.has(file)) continue;
      const body = await readFile(path.join(repoRoot, file), 'utf8');
      const reached = namedFromModules(body).filter((name) => RESOLVERS.includes(name));
      const whole = [...body.matchAll(WHOLE_MODULE)]
        .map((match) => match[1]!)
        .filter((module) => RESOLVER_MODULES.some((held) => module.includes(held)));
      if (reached.length > 0 || whole.length > 0)
        offenders.push(`${file}: ${[...reached, ...whole].join(', ')}`);
    }
    expect(offenders).toEqual([]);
  });

  it('names every allowed module, and every one of them still exists', async () => {
    const files = new Set(await sourceFiles(repoRoot));
    for (const entry of ALLOWED) {
      expect(files, entry.file).toContain(entry.file);
      expect(entry.because.length, entry.file).toBeGreaterThan(0);
    }
  });

  it('sees a resolver through an alias, a type-only import, a multi-line block and a re-export', () => {
    const body = [
      "import { revisionGoverningState as standing } from '@orcaops/storage/history/database';",
      "import type { resolveKnowledge } from '@orcaops/storage';",
      "import {\n  something,\n  governingStateReader,\n} from '@orcaops/storage/history/database';",
      "export { readProjectGoverningState } from './knowledge-read-governing.js';",
      // A different function whose name merely starts the same way is not a resolver.
      "import { resolveKnowledgeProcessing } from '@orcaops/core';",
    ].join('\n');
    expect(namedFromModules(body).filter((name) => RESOLVERS.includes(name))).toEqual([
      'revisionGoverningState',
      'resolveKnowledge',
      'governingStateReader',
      'readProjectGoverningState',
    ]);
  });

  it('sees a resolver module reached whole, by a namespace import or a star re-export', () => {
    const body = [
      "import * as store from '@orcaops/storage/history/database';",
      "export * from './knowledge-resolution.js';",
      "export * as boundary from './knowledge-read-boundary.js';",
      // A module that hands out no resolver, reached the same way, is not one.
      "import * as core from '@orcaops/core';",
    ].join('\n');

    expect(
      [...body.matchAll(WHOLE_MODULE)]
        .map((match) => match[1]!)
        .filter((module) => RESOLVER_MODULES.some((held) => module.includes(held)))
    ).toEqual([
      '@orcaops/storage/history/database',
      './knowledge-resolution.js',
      './knowledge-read-boundary.js',
    ]);
  });

  it('counts a fixture a test imports as test code, wherever it lives', async () => {
    const files = await sourceFiles(repoRoot);

    expect(files).not.toContain(
      'apps/orcaops-cli/tests/integration/interpretation-measurement.test-support.ts'
    );
    expect(files).not.toContain('packages/review-engine/tests/semantic-publication-controls.ts');
    expect(files).toContain('apps/orcaops-cli/src/lib/knowledge-search-context.ts');
  });
});
