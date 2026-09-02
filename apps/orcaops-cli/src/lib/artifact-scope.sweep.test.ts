import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Source sweep: a branch-scoped artifact read outside the scope helper is a
 * seeded-participation decision nobody made — the unrouted arms silently
 * exclude the imported corpus. Any new call site either routes through
 * resolveBranchReadScope / resolveArtifactScope or earns an explicit
 * allowlist entry here with its recorded policy.
 */

const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Files allowed to query the store by branch directly, with the recorded reason. */
const ALLOWED_DIRECT_CALLERS = new Set([
  // The helper itself — the single place the participation choice applies.
  'lib/artifact-scope.ts',
  // In-flight resolution is live-only by construction: imported artifacts
  // are always summarized, so the state filter excludes them before the
  // branch scope matters.
  'lib/active-artifact.ts',
  // Write path: superseded-baseline resolution on capture, not a read surface.
  'commands/capture/plan.ts',
]);

const BRANCH_SCOPED_CALL_PATTERNS = [
  /listArtifactsByLineageBranch\s*\(/u,
  /listArtifacts\s*\(\s*\{[^}]*\bbranch\b/u,
];

/** Read arms already converted; each must keep importing the shared helper. */
const CONVERTED_READ_ARMS = [
  'commands/list.ts',
  'commands/status.ts',
  'commands/decisions.ts',
  'commands/loose-ends.ts',
  'commands/diff.ts',
  'commands/digest.ts',
  'commands/stats.ts',
  'commands/resume.ts',
];

async function sourceFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await sourceFiles(full)));
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
}

describe('branch-scoped artifact reads', () => {
  it('route every direct branch-scoped store query through the scope helper', async () => {
    const offenders: string[] = [];
    for (const file of await sourceFiles(SRC_ROOT)) {
      const rel = path.relative(SRC_ROOT, file).split(path.sep).join('/');
      if (ALLOWED_DIRECT_CALLERS.has(rel)) continue;
      const text = await readFile(file, 'utf8');
      if (BRANCH_SCOPED_CALL_PATTERNS.some((pattern) => pattern.test(text))) {
        offenders.push(rel);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('keep the converted read arms on the shared helper', async () => {
    for (const rel of CONVERTED_READ_ARMS) {
      const text = await readFile(path.join(SRC_ROOT, rel), 'utf8');
      expect(text, `${rel} must import lib/artifact-scope`).toMatch(/artifact-scope\.js/u);
      expect(text, `${rel} must resolve scope through the helper`).toMatch(
        /resolveBranchReadScope|resolveArtifactScope/u
      );
    }
  });
});
