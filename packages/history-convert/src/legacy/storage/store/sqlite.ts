export interface UsageSnapshotRow {
  snapshot_id: string;
  idempotency_key: string;
  artifact_id: string | null;
  source_plan_ref_id: string | null;
  agent: string;
  session_id: string;
  lifecycle_event: string;
  checkpoint_n: number | null;
  cumulative_input_tokens: number;
  cumulative_output_tokens: number;
  cumulative_cache_creation_input_tokens: number;
  cumulative_cache_read_input_tokens: number;
  delta_input_tokens: number | null;
  delta_output_tokens: number | null;
  delta_cache_creation_input_tokens: number | null;
  delta_cache_read_input_tokens: number | null;
  baseline_kind: string;
  model_breakdown: string;
  dimensions: string;
  record_count: number;
  as_of: string;
  ts: string;
}
export interface SourcePlanLinkRow {
  source_plan_ref_id: string;
  artifact_id: string;
  linked_at: string;
  pinned_version: string | null;
}
