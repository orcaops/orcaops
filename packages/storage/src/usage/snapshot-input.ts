import type { AgentUsage, UsageBaselineKind } from '../schema/usage-ledger.js';

export interface RecordUsageSnapshotInput {
  agent: string;
  session_id: string;
  artifact_id?: string | null;
  source_plan_ref_id?: string | null;
  lifecycle_event: string;
  checkpoint_n?: number | null;
  cumulative_usage: AgentUsage;
  model_breakdown: Array<{
    model: string;
    speed?: string;
    service_tier?: string;
    inference_geo?: string;
    cumulative: AgentUsage;
  }>;
  record_count: number;
  as_of: string;
  ts: string;
  baseline_hint: UsageBaselineKind;
  idempotency_key: string;
}

export interface AppendSourcePlanLinkInput {
  canonical_ref_id: string;
  artifact_id: string;
  linked_at: string;
  pinned_version?: string | null;
  idempotency_key: string;
}
