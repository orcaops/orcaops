import { access, chmod, mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

function dataRoot(env: NodeJS.ProcessEnv, home: string): string {
  const override = env.ORCAOPS_DATA_DIR?.trim();
  if (override) return override;
  const xdg = env.XDG_DATA_HOME?.trim();
  if (xdg) return path.join(xdg, 'orcaops');
  return path.join(home, '.orcaops');
}

export function checkoutsRoot(env: NodeJS.ProcessEnv, home: string = homedir()): string {
  const xdg = env.XDG_CACHE_HOME?.trim();
  if (xdg) return path.join(xdg, 'orcaops', 'checkouts');
  return path.join(dataRoot(env, home), 'checkouts-cache');
}

export async function ensureDir0700(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') await chmod(dir, 0o700);
}

const CACHEDIR_TAG_CONTENT =
  'Signature: 8a477f597d28d172789f06886806bc55\n' +
  '# This file is a cache directory tag created by orcaops.\n' +
  '# For information about cache directory tags, see https://bford.info/cachedir/\n';

export async function writeCachedirTag(root: string): Promise<void> {
  await ensureDir0700(root);
  const tagPath = path.join(root, 'CACHEDIR.TAG');
  try {
    await access(tagPath);
    return;
  } catch {
    await writeFile(tagPath, CACHEDIR_TAG_CONTENT, { flag: 'w' });
  }
}
