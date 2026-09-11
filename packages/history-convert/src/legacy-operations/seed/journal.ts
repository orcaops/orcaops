import { z } from 'zod';
const SeedJournalClusterSchema = z.object({
  artifact_id: z.string().min(1),
  status: z.enum(['pending', 'writing', 'complete', 'covered', 'failed']),
  error: z.string().optional(),
});
const SeedJobRecordSchema = z.object({
  kind: z.enum(['initial', 'importance', 'commit', 'path', 'resume']),
  invoked_by: z.string().min(1).optional(),
  started_at: z.string().datetime(),
  finished_at: z.string().datetime().optional(),
  wall_time_ms: z.number().int().nonnegative().optional(),
  budget: z
    .object({
      max_commits: z.number().int().positive(),
      selected_commits: z.number().int().nonnegative(),
      commits_beyond: z.number().int().nonnegative().optional(),
      clusters_beyond: z.number().int().nonnegative().optional(),
    })
    .optional(),
  skipped_covered: z.number().int().nonnegative().optional(),
  skips: z
    .array(z.object({ cluster_key: z.string().min(1), reason: z.string().min(1) }))
    .optional(),
});
export const SeedJournalSchema = z.object({
  schema_version: z.literal(2),
  install_nonce: z.string().regex(/^[0-9a-f]{32}$/u),
  options_hash: z.string(),
  updated_at: z.string().datetime(),
  clusters: z.record(z.string(), SeedJournalClusterSchema),
  jobs: z.record(z.string(), SeedJobRecordSchema),
});
export const SeedJournalV1Schema = z.object({
  schema_version: z.literal(1),
  install_nonce: z.string().regex(/^[0-9a-f]{32}$/u),
  options_hash: z.string(),
  pr_context: z.boolean(),
  pending_importance: z.boolean(),
  updated_at: z.string().datetime(),
  clusters: z.record(z.string(), SeedJournalClusterSchema),
  declined_discovery_areas: z.array(z.string()),
  commit_graph_hint_shown: z.boolean().optional(),
});
const SeedDiscoveryAreaSchema = z.object({
  declined_at: z.string().datetime().optional(),
  offered_at: z.string().datetime().optional(),
  declined_paths: z.array(z.string()).optional(),
});
export const SeedPreciousStateSchema = z.object({
  schema_version: z.literal(1),
  install_nonce: z.string().regex(/^[0-9a-f]{32}$/u),
  pr_context: z.boolean(),
  pending_importance: z.boolean(),
  commit_graph_hint_shown: z.boolean(),
  discovery_areas: z.record(z.string(), SeedDiscoveryAreaSchema),
  updated_at: z.string().datetime(),
});
const SeedCoverageDirectorySchema = z.object({
  covered_lines: z.number().int().nonnegative(),
  total_lines: z.number().int().nonnegative(),
  percent: z.number().min(0).max(100),
});
export const SeedCoverageReportSchema = z.object({
  schema_version: z.literal(1),
  branch_sha: z.string().regex(/^[0-9a-f]{40}$/u),
  generated_at: z.string().datetime(),
  complete: z.boolean(),
  directories: z.record(z.string(), SeedCoverageDirectorySchema),
});
