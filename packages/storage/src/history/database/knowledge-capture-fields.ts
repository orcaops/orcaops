import type { ProjectReadView } from './connection.js';
import { integrity, missing } from './knowledge-record-input.js';

const fieldAt = (payload: unknown, fieldPath: string): string | null => {
  let value = payload;
  const normalized = fieldPath.replace(/\[(\d+)\]/gu, '.$1');
  const parts = normalized.split('.');
  if (parts.some((part) => part.length === 0)) return null;
  for (const part of parts) {
    if (value === null || typeof value !== 'object') return null;
    if (Array.isArray(value)) {
      if (!/^\d+$/u.test(part)) return null;
      value = value[Number(part)];
    } else value = (value as Record<string, unknown>)[part];
  }
  return typeof value === 'string' ? value : null;
};

export function readRetainedCaptureField(view: ProjectReadView, sourceId: string) {
  const row = view.get<{
    artifact_id: string;
    event_id: string;
    field_path: string;
    position: number;
    record: string;
    sidecar_hex: string | null;
  }>(
    `SELECT s.artifact_id, s.event_id, s.field_path, s.position,
       CAST(e.record_bytes AS TEXT) AS record,
       CASE WHEN e.sidecar_payload_bytes IS NULL THEN NULL
         ELSE hex(e.sidecar_payload_bytes) END AS sidecar_hex
     FROM knowledge_sources s
     JOIN artifact_events e ON e.artifact_id=s.artifact_id AND e.event_id=s.event_id
     WHERE s.source_id=? AND s.source_kind='capture_field'`,
    sourceId
  );
  if (!row) missing('Evidence requires its retained capture field source');
  let event: unknown;
  let payload: unknown;
  try {
    event = JSON.parse(row.record);
    payload =
      row.sidecar_hex === null
        ? (event as { payload?: unknown }).payload
        : JSON.parse(Buffer.from(row.sidecar_hex, 'hex').toString('utf8'));
  } catch {
    integrity('A retained capture event cannot be decoded for evidence verification');
  }
  const text = fieldAt(payload, row.field_path);
  if (text === null)
    integrity('A retained capture source no longer resolves to its authored field');
  return {
    text,
    occurrence: {
      kind: 'capture_field' as const,
      artifact_id: row.artifact_id,
      event_id: row.event_id,
      field_path: row.field_path,
      position: row.position,
    },
  };
}
