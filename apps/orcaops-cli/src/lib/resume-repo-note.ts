import type { RepoState } from '@orcaops/core';

export function renderRepoStateNote(state: RepoState | null): string {
  if (!state) return '';
  const lines: string[] = [];
  if (state.working_tree_dirty) {
    lines.push('Working tree is dirty.');
  }
  if (!state.head_matches_artifact && state.artifact_head_sha) {
    const ahead = state.commits_since_artifact_head_touching_artifact_files.length;
    if (ahead > 0) {
      lines.push(
        `${ahead} commit(s) since artifact_head_sha touch this artifact's files; ` +
          `your work may already be partly done.`
      );
    } else {
      lines.push(
        `HEAD has moved since this artifact's last recorded head (no overlap with artifact files).`
      );
    }
  }
  if (state.open_items_addressed_since.length > 0) {
    lines.push(
      `${state.open_items_addressed_since.length} open item(s) may already be addressed — ` +
        `see repo_state.open_items_addressed_since.`
    );
  }
  return lines.length > 0 ? `Repo state: ${lines.join(' ')}\n\n` : '';
}
