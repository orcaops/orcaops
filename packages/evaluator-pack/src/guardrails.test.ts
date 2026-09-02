import { execSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Pack-dependency guardrails. Together these enforce the
 * architectural rule:
 *
 *   "Pack runtimes may depend on @orcaops/evaluator-sdk,
 *    @orcaops/evaluator-protocol, and their own external libraries.
 *    They must NOT depend on @orcaops/core, @orcaops/storage, or
 *    @orcaops/cli."
 *
 * Without these checks, a future change that adds a stray
 * `import '@orcaops/core'` to a pack runtime would re-introduce the
 * bundle-bloat and cross-package-coupling these guardrails exist to
 * prevent.
 */

const PACKAGE_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DIST_PACKS = path.join(PACKAGE_ROOT, 'dist', 'packs');
const SRC_PACKS = path.join(PACKAGE_ROOT, 'packs');

const SIZE_BUDGET_BYTES = 200 * 1024;
const FORBIDDEN_IMPORTS = ['@orcaops/core', '@orcaops/storage', '@orcaops/cli'];

function listRuntimeFiles(): string[] {
  const out: string[] = [];
  let packs: string[];
  try {
    packs = readdirSync(DIST_PACKS, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return out;
    throw err;
  }
  for (const pack of packs) {
    const runtimeDir = path.join(DIST_PACKS, pack, 'runtime');
    let entries;
    try {
      entries = readdirSync(runtimeDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isFile()) {
        out.push(path.join(runtimeDir, entry.name));
      }
    }
  }
  return out;
}

describe('pack runtime size budget', () => {
  it('every dist/packs/*/runtime/*.js stays under 200KB', () => {
    const files = listRuntimeFiles().filter(
      (file) => file.endsWith('.js') && !file.endsWith('.js.map')
    );
    if (files.length === 0) {
      throw new Error(
        `No compiled runtime files found under ${DIST_PACKS}. Run \`pnpm build\` first.`
      );
    }
    const violations: string[] = [];
    for (const file of files) {
      const stat = statSync(file);
      if (stat.size > SIZE_BUDGET_BYTES) {
        violations.push(
          `${path.relative(PACKAGE_ROOT, file)} is ${stat.size} bytes (> ${SIZE_BUDGET_BYTES})`
        );
      }
    }
    expect(violations).toEqual([]);
  });
});

describe('pack runtime contents', () => {
  it('does not ship test-only runtime files', () => {
    const testOnlyFiles = listRuntimeFiles()
      .map((file) => path.relative(PACKAGE_ROOT, file))
      .filter((file) => /(?:^|\/)_test-|\.test\./u.test(file));

    expect(testOnlyFiles).toEqual([]);
  });
});

describe('no cross-package imports from pack source', () => {
  it('packs/**/runtime/**/*.ts does not import @orcaops/core | @orcaops/storage | @orcaops/cli', () => {
    let output: string;
    try {
      output = execSync(`grep -rn -E "from '(${FORBIDDEN_IMPORTS.join('|')})'" "${SRC_PACKS}"`, {
        stdio: ['ignore', 'pipe', 'pipe'],
        encoding: 'utf8',
      });
    } catch (err) {
      const e = err as { stdout?: string; status?: number };
      // grep exit 1 = no matches found = pass
      if (e.status === 1 && (e.stdout ?? '').length === 0) {
        return;
      }
      throw err;
    }
    if (output.trim().length > 0) {
      throw new Error(
        `Pack runtime files import forbidden workspace packages:\n${output}\n\n` +
          `Pack runtimes must depend only on @orcaops/evaluator-sdk + ` +
          `@orcaops/evaluator-protocol + external libraries.`
      );
    }
  });
});
