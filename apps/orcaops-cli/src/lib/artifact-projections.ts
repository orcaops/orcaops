import {
  archiveLastWriteMs,
  hotLastWriteMs,
  type ProjectHandle,
  type ProjectScopeIssue,
  resolveArtifactSource,
} from '@orcaops/project-scope';
import { type ArtifactRow, type Store } from '@orcaops/storage';

export interface SelectedArtifactProjection {
  row: ArtifactRow;
  source: 'hot' | 'archive';
  store: Store;
  lastWriteMs: number | null;
  /** A hot twin whose timestamp cannot be trusted stays selected for loud degradation. */
  hotReadError?: unknown;
}

export function unavailableArtifactIdsWithoutSelectedProjection(
  issues: readonly ProjectScopeIssue[],
  selected: readonly SelectedArtifactProjection[]
): string[] {
  const selectedIds = new Set(selected.map((artifact) => artifact.row.id));
  return [
    ...new Set(
      issues
        .filter((issue) => issue.kind === 'artifact_unavailable')
        .map((issue) => issue.artifact_id)
        .filter((id) => !selectedIds.has(id))
    ),
  ].sort();
}

export async function selectProjectArtifacts(
  project: ProjectHandle
): Promise<SelectedArtifactProjection[]> {
  if (project.hotStore === undefined) {
    return project.store.listArtifacts({}).map((row) => ({
      row,
      source: 'archive',
      store: project.store,
      lastWriteMs: project.archiveMeta ? archiveLastWriteMs(project.archiveMeta, row.id) : null,
    }));
  }

  const hotRows = new Map(project.store.listArtifacts({}).map((row) => [row.id, row]));
  const archiveRows = new Map(
    (project.archiveStore?.listArtifacts({}) ?? []).map((row) => [row.id, row])
  );
  const ids = [...new Set([...hotRows.keys(), ...archiveRows.keys()])].sort();
  const selected: SelectedArtifactProjection[] = [];

  for (const id of ids) {
    const hotRow = hotRows.get(id);
    const archiveRow = archiveRows.get(id);
    let hotMs: number | null = null;
    let hotReadError: unknown;
    if (hotRow !== undefined && archiveRow !== undefined) {
      try {
        hotMs = await hotLastWriteMs(project.hotStore, id);
      } catch (error) {
        hotReadError = error;
      }
    }
    if (hotReadError !== undefined) {
      selected.push({
        row: hotRow!,
        source: 'hot',
        store: project.store,
        lastWriteMs: null,
        hotReadError,
      });
      continue;
    }

    const resolution = resolveArtifactSource({
      hotPresent: hotRow !== undefined,
      archivePresent: archiveRow !== undefined,
      hotLastWriteMs: hotMs,
      archiveLastWriteMs:
        archiveRow !== undefined && project.archiveMeta !== undefined
          ? archiveLastWriteMs(project.archiveMeta, id)
          : null,
    });
    if (resolution === null) continue;
    const archive = resolution.source === 'archive';
    selected.push({
      row: archive ? archiveRow! : hotRow!,
      source: resolution.source,
      store: archive ? project.archiveStore! : project.store,
      lastWriteMs: resolution.lastWriteMs,
    });
  }
  return selected;
}
