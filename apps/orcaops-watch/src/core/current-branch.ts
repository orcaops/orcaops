// The branch currently checked out in a hot repo — the signal behind the
// cockpit's "current checkout" / "● here" thread markers, and the tiebreak that
// sorts a task's checked-out member first. Review entry resolves the owning
// worktree per row rather than reading this. Read-only (`git symbolic-ref`),
// one cheap plumbing spawn per hot project per tick — never mints an object.
// Tolerant: a detached HEAD / bare repo / spawn failure returns null, and every
// thread then reads `isCurrentCheckout: false` (an unmarked, still-reviewable row).

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** The checked-out branch of `repoRoot`, or null when detached/unresolvable. */
export async function readCurrentBranch(repoRoot: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], {
      cwd: repoRoot,
    });
    const branch = stdout.trim();
    return branch.length > 0 ? branch : null;
  } catch {
    return null;
  }
}
