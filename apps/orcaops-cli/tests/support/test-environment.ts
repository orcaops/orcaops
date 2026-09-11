import { lstat, realpath } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';

import { checkoutsRoot, pinStoreRoot } from '@orcaops/storage';
import { executionFocusStateRoot } from '@orcaops/storage/history/execution-focus';

async function canonicalPath(selected: string): Promise<string> {
  try {
    return await realpath(selected);
  } catch (error) {
    if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    const entry = await lstat(selected).catch((cause: NodeJS.ErrnoException) => {
      if (cause.code === 'ENOENT' || cause.code === 'ENOTDIR') return null;
      throw cause;
    });
    if (entry?.isSymbolicLink())
      throw new Error(`Test storage isolation: unresolved symlink: ${selected}`);
    const parent = path.dirname(selected);
    if (parent === selected) throw error;
    return path.join(await canonicalPath(parent), path.basename(selected));
  }
}

export async function assertIsolatedTestEnvironment(
  env: NodeJS.ProcessEnv,
  cwd: string
): Promise<void> {
  const temporary = await realpath(tmpdir());
  const data =
    env.ORCAOPS_DATA_DIR?.trim() ||
    (env.XDG_DATA_HOME?.trim()
      ? path.join(env.XDG_DATA_HOME.trim(), 'orcaops')
      : path.join(homedir(), '.orcaops'));
  for (const [name, selected] of [
    ['history', data],
    ['checkout cache', checkoutsRoot(env)],
    ['pins', pinStoreRoot(env)],
    ['execution focus', executionFocusStateRoot(env)],
  ] as const) {
    // Resolve existing ancestors so a missing child of a symlink cannot escape the guard.
    const resolved = await canonicalPath(path.resolve(cwd, selected));
    const relative = path.relative(temporary, resolved);
    if (
      !relative ||
      relative === '..' ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      throw new Error(
        `Test storage isolation: ${name} resolves outside temporary storage: ${resolved}`
      );
    }
  }
}
