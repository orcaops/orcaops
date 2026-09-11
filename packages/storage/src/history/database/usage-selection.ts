import type { ProjectReadView } from './connection.js';
import { ProjectDatabaseError } from './errors.js';

export function assertUsageSelection(view: ProjectReadView): void {
  const selected = view.get<{
    generation: number | null;
  }>(`SELECT r.generation FROM usage_selection s
    LEFT JOIN usage_revisions r ON r.generation = s.current_generation WHERE s.singleton = 1`);
  if (selected && selected.generation !== null) return;
  if (
    selected ||
    view.get(`SELECT 1 AS retained FROM usage_events
    UNION ALL SELECT 1 FROM usage_revisions UNION ALL SELECT 1 FROM usage_snapshots
    UNION ALL SELECT 1 FROM usage_links LIMIT 1`)
  ) {
    throw new ProjectDatabaseError(
      'HISTORY_INTEGRITY_REQUIRED',
      'Retained usage has no valid current publication selection; preserve history for explicit repair'
    );
  }
}

export function assertUsageAccountingRows(view: ProjectReadView): void {
  assertUsageSelection(view);
  const missing = view.get(`SELECT event_id FROM usage_events e
    WHERE event_type = 'agent_usage_snapshot_recorded' AND NOT EXISTS (SELECT 1 FROM usage_snapshots s WHERE s.event_id = e.event_id)
    UNION ALL SELECT event_id FROM usage_events e
    WHERE event_type = 'source_plan_linked' AND NOT EXISTS (SELECT 1 FROM usage_links l WHERE l.event_id = e.event_id)
    UNION ALL SELECT s.event_id FROM usage_snapshots s LEFT JOIN usage_events e ON e.event_id = s.event_id
    WHERE e.event_type IS NOT 'agent_usage_snapshot_recorded'
    UNION ALL SELECT l.event_id FROM usage_links l LEFT JOIN usage_events e ON e.event_id = l.event_id
    WHERE e.event_type IS NOT 'source_plan_linked' LIMIT 1`);
  if (missing)
    throw new ProjectDatabaseError(
      'HISTORY_INTEGRITY_REQUIRED',
      'Usage accounting rows are incomplete; preserve original history and explicitly rebuild derived accounting before retrying'
    );
}
