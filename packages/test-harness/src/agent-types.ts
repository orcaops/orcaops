import type { EvaluatorPhase } from '@orcaops/evaluator-protocol';
import type { SearchType } from '@orcaops/evaluator-protocol/search-types';

/**
 * Raw result from spawning the orcaops binary (or running it
 * in-process). Useful when you want to inspect stderr or exitCode
 * directly (e.g., when the test expects a non-zero exit).
 */
export interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * The success envelope shape that all `--json` commands return on `ok: true`.
 * Specific commands narrow the rest of the payload via the typed methods
 * on `InProcessAgent`.
 */
export interface OkEnvelope {
  ok: true;
  [key: string]: unknown;
}

/**
 * The error envelope shape that the CLI emits on stdout (with exitCode 1)
 * for any structured failure.
 */
export interface ErrorEnvelope {
  ok: false;
  error: {
    code: string;
    message: string;
    path?: string;
  };
}

export interface SyntheticAgentOptions {
  /** Working directory — typically a temp repo from `createTempRepo`. */
  cwd: string;
  /** Absolute path to `bin/orcaops.js` from the orcaops CLI app. */
  binPath: string;
  /** Extra environment variables; merged onto `process.env`. */
  env?: Record<string, string>;
  /**
   * Per-call timeout in ms (default 30s). Most commands return fast; the
   * generous default covers integration-test environments where evaluator
   * runs (even deterministic ones) can take a beat.
   */
  timeoutMs?: number;
}

/**
 * Thrown when an agent method expected `ok: true` but got an error
 * envelope (or a non-zero exit). The full raw result is attached for
 * inspection.
 */
export class SyntheticAgentError extends Error {
  constructor(
    message: string,
    public readonly result: CliResult,
    public readonly envelope?: ErrorEnvelope
  ) {
    super(message);
    this.name = 'SyntheticAgentError';
  }
}

// ── Typed envelope shapes (success path) ─────────────────────────────────
// These mirror what the corresponding capture / status / show commands
// emit. We intentionally don't import the CLI's types to keep
// `@orcaops/test-harness`'s type surface decoupled from `@orcaops/core`'s
// internal shapes.

export interface InitOk extends OkEnvelope {
  repo_root: string;
  config_path: string;
  agent_tool: string | null;
  agent_skills_installed: string[];
  agent_commands_installed: string[];
  llm_tool: 'auto' | 'claude' | 'codex' | 'none';
}

export interface UpdateOk extends OkEnvelope {
  orcaops_version: string;
  agent_tool: string;
  installed: string[];
  refreshed: string[];
  unchanged: string[];
}

export interface EvaluatorRunResult {
  evaluator: string;
  severity: 'info' | 'warn' | 'block';
  status: 'pass' | 'warn' | 'violation' | 'acknowledged' | 'error';
  body: string;
  fires_at: EvaluatorPhase;
}

export interface CapturePlanOk extends OkEnvelope {
  artifact_id: string;
  branch: string;
  evaluator_results: EvaluatorRunResult[];
  blocking: boolean;
  /** Server-minted step shapes; carries stable UUIDv7 step_ids in plan order. */
  plan_steps: Array<{ step_id: string; idx: number; text: string; label: string }>;
  revision_n: number;
}

/** Apply lifecycle constraints represented by the harness envelope above. */
export type SyntheticEvaluatorFiresAt = EvaluatorRunResult['fires_at'];

export interface CaptureCheckpointOk extends OkEnvelope {
  artifact_id: string;
  n: number;
  evaluator_results: EvaluatorRunResult[];
  blocking: boolean;
}

export interface CaptureSummaryOk extends OkEnvelope {
  artifact_id: string;
  completed_at: string;
}

export interface CapturePrePrCheckOk extends OkEnvelope {
  artifact_id: string;
  evaluator_results: EvaluatorRunResult[];
  blocking: boolean;
}

export interface BlockAcknowledgeOk extends OkEnvelope {
  artifact_id: string;
  evaluator: string;
  action: 'acknowledged';
  acknowledged_at: string;
}

export interface BlockDismissOk extends OkEnvelope {
  artifact_id: string;
  evaluator: string;
  action: 'dismissed';
  dismissed_at: string;
}

export interface ArtifactStatus {
  id: string;
  state: 'planned' | 'active' | 'blocked' | 'summarized';
  thread: Record<string, { status: string; count?: number }>;
  capture_health: 'ok' | 'stale' | 'broken';
}

export interface StatusOk extends OkEnvelope {
  branch: string;
  artifacts: ArtifactStatus[];
}

export interface ListOk extends OkEnvelope {
  artifacts: Array<{ id: string; branch: string; task: string; state: string }>;
}

export interface ShowOk extends OkEnvelope {
  artifact: Record<string, unknown>;
}

export interface EvalListOk extends OkEnvelope {
  evaluators: Array<{
    name: string;
    severity: 'info' | 'warn' | 'block';
    fires_at: EvaluatorPhase;
    mode: 'deterministic' | 'llm';
  }>;
}

export interface DigestOk extends OkEnvelope {
  artifact_id: string;
  cached_at: string;
  data: Record<string, unknown>;
  markdown: string;
}

export interface WhyMatchSummary {
  artifact_id: string;
  branch: string;
  task: string;
  checkpoint_n: number;
  checkpoint_summary: string;
  checkpoint_head_sha: string;
  ts: string;
  confidence: 'exact' | 'likely' | 'weak' | 'none';
  reason: string;
}

interface WhyBaseOk extends OkEnvelope {
  file: string;
  blame_sha: string | null;
  best: WhyMatchSummary | null;
  hint?: string;
}

export interface WhyWholeFileOk extends WhyBaseOk {
  mode: 'whole-file';
  line: null;
  all: WhyMatchSummary[];
}

export interface WhyLineOk extends WhyBaseOk {
  mode: 'line';
  line: number;
  all?: WhyMatchSummary[];
}

export type WhyOk = WhyWholeFileOk | WhyLineOk;

export interface SearchOk extends OkEnvelope {
  query: string;
  branch: string | null;
  type: SearchType | null;
  count: number;
  results: Array<{
    artifact_id: string;
    source: string;
    branch: string;
    ts: string;
    snippet: string;
  }>;
}

/**
 * Resolved resume — the picker found exactly one in-flight artifact
 * (or the caller passed `--artifact` / `--accept-default`).
 */
export interface ResumeResolvedOk extends OkEnvelope {
  schema_version: 2;
  resolved: true;
  resolution_via: 'pin' | 'single-active' | 'explicit-flag' | 'no-active-artifacts';
  artifact: {
    artifact_id: string;
    branch: string;
    task: string;
    started_at: string;
    is_complete: boolean;
    checkpoint_count: number;
    last_checkpoint_head_sha: string | null;
    steps: Array<{ step: string; done: boolean; evidence_checkpoint?: number }>;
    // Mirrors ResumeData['decisions'] in @orcaops/core (resume/builder.ts) —
    // keep in lockstep. `source` discriminates plan- vs checkpoint-provenance.
    decisions: Array<{
      decision: string;
      reason: string;
      source: 'plan' | 'checkpoint';
      checkpoint?: number;
      revision_n?: number;
      alternatives_considered?: Array<{ option: string; rejected_because: string }>;
    }>;
    open_uncertainty: Array<{ item: string; checkpoint: number }>;
    open_items: string[];
    agent_prompt: string;
    cached_at: string;
    copied: boolean;
    /** True when the picker fell back to SHA reachability. */
    lineage_stale: boolean;
    /** Lineage branches recorded on the chosen artifact; null unless lineage_stale. */
    lineage_branches: string[] | null;
  } | null;
  /** Present only on resolved-empty (resolution_via='no-active-artifacts'). */
  next_actions?: Array<{ verb: string; command: string; effect: string }>;
}

/**
 * Ambiguous picker — multiple in-flight artifacts on the branch and
 * no pin to disambiguate. Caller must retry with one of the
 * `next_actions` or pass `--accept-default`.
 */
export interface ResumeAmbiguous extends OkEnvelope {
  schema_version: 2;
  resolved: false;
  reason: 'multiple-active-no-pin';
  shell_key: { kind: string; value?: string };
  candidates: Array<{
    id: string;
    task: string;
    branch: string;
    started_at: string;
    last_activity_at: string;
    state: 'planned' | 'active' | 'blocked' | 'summarized';
    checkpoint_count: number;
    created_by_session_id: string | null;
    files_touched_recently: string[];
    summary_excerpt: string | null;
  }>;
  default_candidate_id: string;
  default_rationale: string;
  next_actions: Array<{ verb: string; command: string; effect: string }>;
}

export type ResumeOk = ResumeResolvedOk | ResumeAmbiguous;
