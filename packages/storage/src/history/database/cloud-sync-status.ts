import { selectArtifactPushCurrent } from './artifact-push-owner.js';
import { decodeArtifactPush, selectArtifactPush } from './artifact-push-reader.js';
import {
  cloudIntegrity,
  parseCloudSyncKey,
  selectCloudSources,
  selectCloudState,
} from './cloud-sync-records.js';
import { hydrateProjectCloudSyncState } from './cloud-sync.js';
import { assertProjectDatabasePath, type ProjectDatabase } from './connection.js';
import {
  hydrateProjectArtifactRows,
  prepareProjectArtifactQuery,
  selectProjectArtifactRows,
} from './query.js';

export function readProjectCloudSyncStatus(handle: ProjectDatabase) {
  assertProjectDatabasePath(handle);
  const query = prepareProjectArtifactQuery({ origin: 'captured', profile: 'versions' });
  const snapshot = handle.read((view) => {
    const artifacts = selectProjectArtifactRows(view, query);
    const keys = view.all<{
      artifactId: string;
      server_url: string;
      org_id: string;
      account_id: string;
    }>(`SELECT artifact_id AS artifactId, server_url, org_id, account_id FROM cloud_sync_records
      UNION SELECT artifact_id, server_url, org_id, account_id FROM cloud_sync_current
      UNION SELECT artifact_id, server_url, org_id, account_id FROM artifact_push_requests
      UNION SELECT artifact_id, server_url, org_id, account_id FROM artifact_push_current
      UNION SELECT artifact_id, server_url, org_id, account_id FROM remote_requests
        WHERE owner_kind='artifact_push'
      UNION SELECT json_extract(target_json,'$.artifactId'),
        json_extract(target_json,'$.target.server_url'),json_extract(target_json,'$.target.org_id'),
        json_extract(target_json,'$.target.account_id') FROM operations
        WHERE operation_kind IN ('cloud.sync.failure','artifact.push.begin','artifact.push.complete')
      ORDER BY 1,2,3,4`);
    const states = keys.map(({ artifactId, ...target }) => {
      let key;
      try {
        key = parseCloudSyncKey({ artifactId, target });
      } catch (cause) {
        cloudIntegrity(cause);
      }
      const sources = selectCloudSources(view, artifactId);
      if (sources === null) cloudIntegrity();
      const current = selectArtifactPushCurrent(view, artifactId, target);
      const push = current === null ? null : selectArtifactPush(view, current.selection.pushId);
      if (current !== null && push === null) cloudIntegrity();
      return { key, sources, cloud: selectCloudState(view, key), push };
    });
    return { artifacts, states };
  });
  const artifacts = hydrateProjectArtifactRows({
    value: snapshot.value.artifacts,
    counters: snapshot.counters,
  }).rows;
  const states = snapshot.value.states.map(({ key, cloud, sources, push }) => ({
    key,
    state: hydrateProjectCloudSyncState(key, {
      value: { cloud, sources },
      counters: snapshot.counters,
    })!,
    recoveryPending: push !== null && decodeArtifactPush(push).terminal === null,
  }));
  const byArtifact = new Map<string, typeof states>();
  for (const state of states) {
    const rows = byArtifact.get(state.key.artifactId) ?? [];
    rows.push(state);
    byArtifact.set(state.key.artifactId, rows);
  }
  const rows = artifacts.flatMap((artifact) => {
    const retained = byArtifact.get(artifact.artifactId) ?? [];
    const entries = retained.length ? retained : [null];
    return entries.map((entry) => {
      const state = entry?.state;
      const failures = state?.consecutiveFailures ?? 0;
      const attemptedAt = state?.lastAttemptAt ?? null;
      const nextAttemptAt =
        failures > 0 && attemptedAt !== null && Number.isFinite(Date.parse(attemptedAt))
          ? new Date(
              Date.parse(attemptedAt) + Math.min(3600, 30 * 2 ** Math.min(failures - 1, 7)) * 1000
            ).toISOString()
          : null;
      return {
        artifactId: artifact.artifactId,
        branch: artifact.branch,
        startedAt: artifact.startedAt,
        target: entry?.key.target ?? null,
        syncedAt: state?.publicState?.syncedAt ?? null,
        lastAttemptAt: attemptedAt,
        lastError: state?.lastError ?? null,
        consecutiveFailures: failures,
        nextAttemptAt,
        recoveryPending: entry?.recoveryPending ?? false,
        pending: entry === null || entry.recoveryPending || entry.state.pending,
      };
    });
  });
  return { rows, counters: snapshot.counters };
}
