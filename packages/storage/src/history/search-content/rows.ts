export interface SearchProjectionSource {
  artifact_id: string;
  source_id: string;
  source_kind: string;
  origin_rank: 0 | 1;
  evidence_time: string | null;
  tokens_json: string;
  payload_json: string;
}

export interface SearchProjectionKey {
  project_id: string;
  match_class: number;
  origin_rank: number;
  evidence_time: string | null;
  artifact_id: string;
  source_id: string;
}

export interface SearchQuery {
  query: readonly string[];
  artifactIds: readonly string[];
  sourceKinds: readonly string[];
  limit: number;
  scanLimit?: number;
}

export interface SearchProjectionMatch extends SearchProjectionKey {
  payload_json: string;
}

export interface SearchProjectionBatch {
  rows: SearchProjectionMatch[];
  counts: { captured: number | null; imported: number | null };
  rankingComplete: boolean;
  candidateComplete: boolean;
  sourceComplete: boolean;
  scanned: number;
  elapsedMs: number;
}
