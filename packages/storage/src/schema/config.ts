import { z } from 'zod';

export { DEFAULT_CAPTURE_EXCLUDE } from '@orcaops/evaluator-protocol';

import { ConfigValidationError } from './validation.js';
import { assertSafeRelativePath } from '../paths/containment.js';

export const DEFAULT_EVALUATOR_MODEL = 'claude-sonnet-4-6';

/**
 * Repo-relative storage path from checked-in config. Absolute paths and
 * `..` escapes (including normalized `a/../../b` shapes) are refused so a
 * cloned repository's config can never point writes or deletions outside
 * its own working tree.
 */
const RepoRelativePathSchema = z.string().superRefine((value, ctx) => {
  try {
    assertSafeRelativePath(value, 'path');
  } catch (err) {
    ctx.addIssue({ code: 'custom', message: (err as Error).message });
  }
});

/**
 * The config schema version this orcaops understands — a constant-driven
 * `z.literal`, not a multi-version union, so exactly one shape is PARSED. More
 * than one generation is loadable: `resolveConfig` normalizes an accepted
 * predecessor to this version before the literal ever sees it, and
 * `assertConfigVersionCurrent` gates the load on that same set. A future shape
 * change must bump this constant and define its own version transition.
 */
export const CONFIG_SCHEMA_VERSION = 6;

/**
 * Versions this build still loads besides the current one.
 *
 * v5 differs from v6 by the absence of the `capture` and `redact` blocks, both
 * fully defaulted — so a v5 file loads to exactly the v6 shape. Accepting it
 * avoids repeating the v4-to-v5 break, which had no migration path and sent
 * every existing checkout through `init --force --reset-config`, discarding
 * whatever else that config held. A predecessor belongs here only while the
 * delta is purely additive and defaulted; a removed or retyped field must
 * still break loudly.
 */
const ACCEPTED_PREDECESSOR_VERSIONS: readonly number[] = [5];

/**
 * Whether `version` is a schema version this build loads — the current one or
 * an accepted predecessor. Callers that branch on config shape must use this
 * rather than comparing to {@link CONFIG_SCHEMA_VERSION}, or a repository still
 * on the predecessor is treated as having no configuration at all.
 */
export function isAcceptedConfigVersion(version: unknown): boolean {
  return (
    version === CONFIG_SCHEMA_VERSION ||
    (typeof version === 'number' && ACCEPTED_PREDECESSOR_VERSIONS.includes(version))
  );
}

/**
 * `.orcaops/config.json` must carry the literal NUMBER 6, or one of
 * {@link ACCEPTED_PREDECESSOR_VERSIONS}. Unversioned files are not loadable,
 * and a stringified version is rejected rather than coerced so the on-disk
 * contract stays exact. A version ahead of 6 keeps the newer-orcaops message. Throws
 * ConfigValidationError so the CLI boundary renders the INVALID_CONFIG
 * envelope.
 */
export function assertConfigVersionCurrent(raw: unknown): void {
  const v =
    raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>).schema_version
      : undefined;
  if (v === CONFIG_SCHEMA_VERSION) return;
  if (typeof v === 'number' && ACCEPTED_PREDECESSOR_VERSIONS.includes(v)) return;
  if (typeof v === 'string') {
    throw new ConfigValidationError(
      `.orcaops/config.json schema_version must be the number ${CONFIG_SCHEMA_VERSION}, ` +
        `got the string "${v}" — edit it to an unquoted ${CONFIG_SCHEMA_VERSION}, or run ` +
        '`orcaops init --force --reset-config` to restore current defaults.',
      'schema_version'
    );
  }
  if (typeof v === 'number' && v > CONFIG_SCHEMA_VERSION) {
    throw new ConfigValidationError(
      `.orcaops/config.json is schema_version ${v}, but this orcaops only understands ` +
        `up to ${CONFIG_SCHEMA_VERSION}. Upgrade orcaops (or check out a newer build).`,
      'schema_version'
    );
  }
  const shown = typeof v === 'number' ? String(v) : 'missing';
  throw new ConfigValidationError(
    `.orcaops/config.json is schema_version ${shown}, but this orcaops requires ` +
      `${CONFIG_SCHEMA_VERSION}. Re-run \`orcaops init --force --reset-config\` to regenerate the config ` +
      `(or hand-edit it to the current v${CONFIG_SCHEMA_VERSION} shape) and retry.`,
    'schema_version'
  );
}

/**
 * The overlay-backed install-target ids. This is the concrete subtype
 * `config.install.agents` is constrained to — the agents orcaops can actually
 * generate skills/commands/blocks for. It lives here in storage (not adapters) so
 * `ConfigSchema` can validate against it without a storage→adapters import; the
 * adapter overlay is asserted to match this list via a parity test
 * (`overlay.test.ts`, mirroring the `CURATED_HINT_KEYS` ⇄ catalog guard). Adding
 * an overlay row adds a key here in lockstep. APPEND-ONLY: this order drives the
 * canonical install-set sort, so inserting (rather than appending) would churn
 * existing repos' `install.json`.
 */
export const SUPPORTED_AGENT_IDS = [
  'claude-code',
  'codex',
  'cursor',
  'opencode',
  'aider-desk',
  'github-copilot',
  'antigravity-cli',
] as const;
export type SupportedAgentId = (typeof SUPPORTED_AGENT_IDS)[number];

/**
 * The capture-identity ids — the agent values stamped into artifact events
 * (`plan.agent`, per-checkpoint/summary attribution). Since config v3 there is
 * NO static repo-level agent: attribution is runtime-resolved per invocation
 * by the CLI (`--invoked-by-agent` > ORCAOPS_INVOKED_BY_AGENT > ambient env
 * markers > `other`). Distinct from `SUPPORTED_AGENT_IDS` (the install-id
 * space): `aider` is the capture id whose install id is `aider-desk`, and
 * `other` is capture-only. Shared by
 * `PlanSchema`, the checkpoint/summary schemas, and the CLI resolver so the
 * enums can never drift.
 */
export const CAPTURE_AGENT_IDS = [
  'claude-code',
  'cursor',
  'codex',
  'opencode',
  'aider',
  'github-copilot',
  'antigravity-cli',
  'other',
] as const;
export type CaptureAgentId = (typeof CAPTURE_AGENT_IDS)[number];

/**
 * The curated workflow-hint catalog KEYS. The key literals live here in
 * storage so `ConfigSchema` can validate `workflow.hints.keys` against them; the
 * human-readable PROSE for each key lives in `@orcaops/adapters`
 * (`agents-md/hints-catalog.ts`), which depends on storage — keeping the catalog
 * split avoids an adapters→storage→adapters cycle. Append-only: new vetted hints
 * add a key here (and its prose in adapters); a config selecting a removed key
 * fails validation, which is the intended forcing function.
 */
export const CURATED_HINT_KEYS = [
  'commit-on-checkpoint-close',
  'open-checkpoint-before-edits',
  'capture-on-nontrivial',
  'subagent-parallelism',
  'checkpoint-cadence',
] as const;
export type HintKey = (typeof CURATED_HINT_KEYS)[number];

/**
 * Bare identifiers for every skill shipped by the current CLI. Storage owns
 * the literals because config validation cannot depend on adapters; the
 * adapter registry is compile- and test-guarded against this catalog.
 */
export const SKILL_IDS = [
  'capture',
  'checkpoint',
  'plan-approval',
  'pre-pr',
  'finish',
  'summary',
  'digest',
  'why',
  'resume',
  'search',
  'doctor',
  'adversarial-review',
  'loose-ends',
  'decisions',
  'parallel-dispatch',
  'estimate',
  'lessons',
  'timetravel',
  'blame',
  'recap',
  'plan-critique',
  'task-review',
  'review',
  'seed',
  'seed-discovery',
  'author-evaluator',
] as const;
export type SkillId = (typeof SKILL_IDS)[number];

// The root contract is closed: adding or removing a root field requires a
// CONFIG_SCHEMA_VERSION bump and an explicit compatibility decision.
export const ConfigSchema = z.strictObject({
  schema_version: z.literal(CONFIG_SCHEMA_VERSION),
  /**
   * The INSTALL set — which overlay-backed agents orcaops generates
   * skills/commands/blocks for. An empty set installs nothing (manual mode).
   * Written explicitly by `init` and constrained to `SUPPORTED_AGENT_IDS`.
   *
   * There is deliberately no static repo-level `agent` field: artifact
   * attribution is runtime-resolved per invocation because one active agent
   * value would misattribute work in multi-agent repositories.
   */
  install: z
    .strictObject({
      agents: z.array(z.enum(SUPPORTED_AGENT_IDS)).default([]),
      /**
       * Install scope. `project` (default) materializes skills/commands
       * into the repo; `global` materializes them into the per-user global dirs
       * (`~/.claude/skills`, …) tracked in `~/.orcaops/install.local.json`. The
       * instruction block, git hooks, and committed `install.json` are ALWAYS
       * project-scoped regardless. Default merging fills an omitted value.
       */
      // 'personal': skills via the GLOBAL machinery, the
      // bootstrap block in CLAUDE.local.md, no committed install.json, and
      // .git/info/exclude keeping `git status` clean. Claude Code only in v1.
      scope: z.enum(['project', 'global', 'personal']).default('project'),
      /** How global artifacts are materialized: `copy` (default, safe) or `symlink`. */
      link: z.enum(['copy', 'symlink']).default('copy'),
    })
    .default({ agents: [], scope: 'project', link: 'copy' }),
  /**
   * LLM provider config. Orcaops uses the user's local CLI tools (claude,
   * codex) instead of holding API keys directly.
   */
  llm: z.strictObject({
    tool: z.enum(['auto', 'claude', 'codex', 'none']),
    model: z.string().min(1).nullable(),
    effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']),
    default_max_cost_usd: z.number().positive(),
  }),
  artifacts: z.strictObject({
    // Checked-in config cannot select storage outside the repository:
    // absolute paths and upward escapes are refused at parse (approved
    // behavior change; see SECURITY.md's second trust boundary).
    path: RepoRelativePathSchema,
    gitignore: z.boolean(),
  }),
  cache: z.strictObject({
    path: RepoRelativePathSchema,
  }),
  evaluators: z.strictObject({
    max_concurrent: z.number().int().positive(),
    on_warn: z.enum(['notify', 'interrupt']),
    on_block: z.enum(['notify', 'interrupt']),
    /**
     * Days after which a recorded disposition (acknowledged / dismissed
     * / policy-excepted) is flagged by `orcaops doctor` as stale.
     * Default 90.
     */
    disposition_ttl_days: z.number().int().positive().default(90),
  }),
  digest: z.strictObject({
    format: z.enum(['markdown', 'json']),
    include_evaluators: z.boolean(),
    include_open_items: z.boolean(),
    include_reasoning: z.boolean(),
    include_rules_applied: z.boolean(),
    redact_secrets: z.boolean(),
  }),
  /**
   * Garbage-collection knobs used by `orcaops gc`.
   */
  gc: z.strictObject({
    /**
     * Days a summarized artifact must sit before `gc` considers it
     * abandoned. Stale-pin and orphan checks ignore this — they're
     * structural, not time-based.
     */
    retention_days: z.number().int().positive(),
  }),
  /**
   * Paths whose contents must never enter a capture snapshot tree.
   *
   * `git add -A` stages the whole worktree, so an untracked-but-not-ignored
   * `.env` is blobbed into `.git/objects` and becomes part of a tree that
   * `snapshots checkout` can materialize OUTSIDE the repository, where the
   * repo's own ignore rules do not reach.
   *
   * Applies to UNTRACKED files only. A tracked file is already in git history,
   * so capture amplifies nothing by including it, and removing one would forge
   * a permanent phantom deletion in every checkpoint manifest.
   */
  capture: z
    .strictObject({
      /**
       * Globs ADDED to the built-in set, never replacing it. This is a
       * security control, so a repository cannot narrow it by declaring one.
       */
      exclude: z.array(z.string().min(1)).default([]),
      /** Escape hatch for the built-in set. Off is a deliberate, loud choice. */
      exclude_builtins: z.boolean().default(true),
    })
    .default({ exclude: [], exclude_builtins: true }),
  /**
   * Secret-refusal knobs.
   *
   * `allow` is the ONLY way to get past a refusal. Under `install.scope`
   * `project` or `global` it lives in committable repository config, so an
   * entry lands in a tracked file and appears in the diff a reviewer reads —
   * louder than the refusal it bypasses. Under `personal` scope the whole
   * `.orcaops/` store sits in `.git/info/exclude` and nothing orcaops writes
   * may touch a tracked path, so an entry made there reaches no reviewer at
   * all. Even where it is visible, the loader does not verify that the file is
   * committed or clean, so this is reviewability rather than a restriction on
   * who may add an entry. A dedicated agent-settable override was rejected for
   * exactly that reason: an override an agent can set by name is not a control
   * at all.
   */
  redact: z
    .strictObject({
      /**
       * Exact literal strings that must not cause a refusal.
       *
       * Matched against the DETECTED SUBSTRING, never a field, a path or a
       * pattern — so an entry names exactly one known-dead credential and
       * cannot grow to cover anything else. Deliberately not globs or regex:
       * a pattern entry is an agent-reachable bypass wearing a config
       * costume, and user-supplied regex over every payload string would add
       * ReDoS to a path that has none.
       *
       * Intended for a published example credential (AWS documents
       * `AKIAIOSFODNN7EXAMPLE`) or a synthetic fixture a human has read and
       * judged dead. Not for silencing a refusal nobody has looked at.
       */
      allow: z.array(z.string().min(1)).default([]),
    })
    .default({ allow: [] }),
  /**
   * Checkpoint diff-fingerprint capture knobs. `enabled` lets a user
   * opt out of snapshot/fingerprint capture entirely (the CLI's
   * snapshot callback honors it before invoking
   * `captureCheckpointSnapshot`). `max_diff_bytes` caps the
   * `git diff` output that flows into the fingerprint manifest
   * builder; past the cap, the manifest is marked `truncated: true`.
   *
   * There is NO `fail_checkpoint_on_error` knob. Fail-open is a hard
   * safety boundary, not user-tunable — snapshot or
   * fingerprint capture failure never blocks the checkpoint
   * lifecycle.
   */
  diff_fingerprint: z.strictObject({
    enabled: z.boolean().default(true),
    max_diff_bytes: z.number().int().positive().default(2_000_000),
  }),
  /**
   * Review-surface knobs. `max_diff_bytes` caps the LIVE `base → pinned`
   * review diff the review engine collects, attributes, and persists to
   * `.orcaops/reviews/<slug>/diff.patch`. Past the cap the diff is truncated
   * (and normalized back to a complete-hunk boundary) and the floor discloses
   * incomplete coverage.
   *
   * Deliberately SEPARATE from `diff_fingerprint.max_diff_bytes`, which caps
   * checkpoint-manifest capture. They are not interchangeable: the fingerprint
   * cap is hashed INTO the durable manifest (`limits.max_diff_bytes`), so
   * changing it perturbs `manifest_hash` for every checkpoint captured under
   * the old value. Tuning the review cap must not carry that blast radius —
   * that separation is the whole point of this key.
   *
   * The default is 10 MB, and it is an INTERACTIVITY budget rather than a
   * storage one. Measured (apps/orcaops-watch/scripts/review-cap-*.ts): the
   * sidecar cost is linear and cheap at any of these sizes, but the TUI rebuilds
   * the whole chapter layout on EVERY keystroke, and that clamp must fit inside
   * a 16 ms frame. It measures 5.8 ms at 10 MB and 20.9 ms at 20 MB — already
   * over budget, before an unstable p95 tail (22–57 ms, GC under a ~580 MB
   * heap). So 20 MB is not "10x headroom", it is a review surface that lags on
   * every key. 10 MB is the largest cap that stays interactive, and it is
   * deliberately below the measured 10–20 MB break because layout also scales
   * with FILE count and the benchmark corpus was narrower than a real branch.
   *
   * Fully defaulted when omitted from a current-shape config. The outer
   * `.default()` is what lets a partial in-memory override omit `review`.
   */
  review: z
    .strictObject({
      max_diff_bytes: z.number().int().positive().default(10_000_000),
      /**
       * Literal repo-relative files or directories whose non-ignored untracked
       * contents are intentional review evidence. Untracked files are excluded
       * by default so local reports and archives cannot consume the review cap.
       */
      include_untracked: z.array(z.string().min(1)).default([]),
      /**
       * Explicit, human-authored diff-stub policy for the routine two-lane
       * forensic payload. Each entry is a glob (picomatch, `**`/`*`) matched
       * against repo-relative changed-file paths. A changed file matching any
       * pattern is NOT carried verbatim in the forensic payload; it is enumerated
       * as a loud stub line (path, add/del rows, byte size, reason
       * `review.stub_paths`) and its bytes do NOT count against the forensic
       * transport ceiling. This is the SANCTIONED remedy for a diff dominated by
       * committed evaluation corpora / run fixtures — never a heuristic, never
       * importance-scored: only these explicit matches stub.
       *
       * Entries pass a permissive shape here (non-strings are rejected at config
       * parse); empty strings and syntactically invalid globs are rejected LOUDLY
       * at routine-start (a parseable STUB_POLICY_INVALID envelope, no payload
       * minted) rather than silently skipped. Additive + fully defaulted.
       */
      stub_paths: z.array(z.string()).default([]),
    })
    .default({ max_diff_bytes: 10_000_000, include_untracked: [], stub_paths: [] }),
  /**
   * Home-dir archive knobs. `enabled` turns on write-through
   * mirroring of the hot store (events + usage ledger) into
   * `~/.orcaops/projects/<project-id>/` — enabled by default and explicitly
   * disableable per worktree (identity itself lives in git local config and is
   * shared across worktrees).
   * `redact_secrets` opts the ARCHIVE COPY into write-time redaction; the
   * hot store is never mutated and defaults preserve byte fidelity so
   * repair stays a pure event-id replay. Fully defaulted when omitted from a
   * current-shape config. Fail-open is not a knob: archive failure never
   * blocks capture.
   */
  archive: z
    .strictObject({
      enabled: z.boolean().default(true),
      redact_secrets: z.boolean().default(false),
    })
    .default({ enabled: true, redact_secrets: false }),
  /**
   * Skill enable/disable overrides. Keyed by bare-verb skill id
   * (`digest`, `standup`, ...): `false` disables a default-on skill, `true`
   * enables an opt-in one; absent ⇒ the template's `defaultEnabled`.
   * Fully defaulted when omitted from a current-shape config. The key space is
   * closed over the current shared skill catalog.
   */
  skills: z
    .strictObject({
      enabled: z.partialRecord(z.enum(SKILL_IDS), z.boolean()).default({}),
    })
    .default({ enabled: {} }),
  /**
   * Skill/command naming prefix. Drives skill names (`${prefix}-capture`)
   * and slash-command names (`${prefix}:status`) AND the managed-block references to
   * them, so they always agree. Default `orcaops`. Lowercase + hyphen-safe; changing
   * it on an existing repo needs the prune machinery — at init it is free.
   * `resolveConfig`'s default-merge fills it for partial in-memory overrides.
   */
  naming: z
    .strictObject({
      prefix: z
        .string()
        .regex(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/, 'prefix must be lowercase and hyphen-safe')
        .default('orcaops'),
    })
    .default({ prefix: 'orcaops' }),
  /**
   * Instruction-block bootstrap mode (persists `--no-agents-md`).
   * `managed` (default) → init/update maintain the managed `## Orcaops` block;
   * `manual` → orcaops never mutates the instruction block (the user owns it),
   * and doctor suppresses the block staleness warning.
   */
  bootstrap: z.enum(['managed', 'manual']).default('managed'),
  /**
   * Agent session-start hooks — the top rung of the bootstrap preference
   * ladder (session hooks > instruction block > manual), independently
   * toggleable from `bootstrap`. Gates the settings-file hook entries
   * (claude-code / codex / cursor) and the generated OpenCode plugin for the
   * hook-capable subset of `install.agents` (capability lives in the adapters
   * overlay). It is fully defaulted, so its absence and its default are the
   * same config. Deliberately NOT a third `bootstrap` enum value, which a
   * reader's z.enum would reject outright.
   */
  session_hooks: z
    .strictObject({
      enabled: z.boolean().default(false),
      /**
       * What `orcaops hook session-start` emits — a CONFIG-LEVEL mode read
       * fresh at every session start, deliberately NOT baked into the
       * installed settings entries (they stay byte-identical across modes,
       * so switching modes is a config flip: no reinstall, no settings
       * churn, no session restart).
       *
       * `static` (default): a fixed short capture nudge, rendered fresh by
       * the installed CLI (prefix-aware — never stale) with zero state
       * reads: no git call, no SQLite open.
       * `state-aware` (EXPERIMENTAL): reads the branch's capture state and
       * tailors the guidance (in-flight thread, open/stale checkpoint).
       * Opt-in because its failure mode is confidently-wrong guidance,
       * not crashes.
       */
      payload: z.enum(['static', 'state-aware']).default('static'),
      /**
       * Which REGISTRATION carries the hook in this repo. `project`
       * (default): settings-file entries reconciled into the repo
       * (project scope only). `none`: no repo entries — `enabled` gates
       * EMISSION alone, for repos covered by the machine-level
       * registration (`orcaops session-hooks install`).
       */
      entries: z.enum(['project', 'none']).default('project'),
    })
    .default({ enabled: false, payload: 'static', entries: 'project' }),
  /**
   * Generated-files git mode (PROJECT scope only). `commit` (default) keeps
   * the generated skill/command trees tracked in git, so a teammate gets them
   * on pull. `ignore` adds adapter-derived `.gitignore` globs so each dev
   * materializes locally (cliff-free thanks to the first-run nudge).
   */
  generated_files: z.enum(['commit', 'ignore']).default('commit'),
  /**
   * Declared workflow preferences rendered INTO the managed block.
   * `hints.keys` selects vetted entries from the curated catalog (CURATED_HINT_KEYS);
   * `hints.custom` is freeform prose rendered verbatim. Empty = no sub-section.
   */
  workflow: z
    .strictObject({
      hints: z
        .strictObject({
          keys: z.array(z.enum(CURATED_HINT_KEYS)).default([]),
          custom: z.array(z.string()).default([]),
        })
        .default({ keys: [], custom: [] }),
    })
    .default({ hints: { keys: [], custom: [] } }),
});

export type Config = z.infer<typeof ConfigSchema>;

/**
 * The complete default config. Every field a user might omit gets filled
 * from this constant before parsing.
 */
export const DEFAULT_CONFIG: Config = {
  schema_version: CONFIG_SCHEMA_VERSION,
  install: {
    agents: ['claude-code'],
    scope: 'project',
    link: 'copy',
  },
  llm: {
    tool: 'auto',
    model: null,
    effort: 'medium',
    default_max_cost_usd: 0.5,
  },
  artifacts: {
    path: '.orcaops/artifacts',
    gitignore: true,
  },
  cache: {
    path: '.orcaops/cache/orcaops.db',
  },
  evaluators: {
    max_concurrent: 4,
    on_warn: 'notify',
    on_block: 'interrupt',
    disposition_ttl_days: 90,
  },
  digest: {
    format: 'markdown',
    include_evaluators: true,
    include_open_items: true,
    include_reasoning: false,
    include_rules_applied: true,
    redact_secrets: true,
  },
  gc: {
    retention_days: 30,
  },
  capture: {
    exclude: [],
    exclude_builtins: true,
  },
  redact: {
    allow: [],
  },
  diff_fingerprint: {
    enabled: true,
    // Durable: recorded inside every checkpoint manifest and hashed into
    // manifest_hash. Not a knob to reach for.
    max_diff_bytes: 2_000_000,
  },
  review: {
    // 10 MB — the largest cap that keeps the review TUI inside a 16 ms frame.
    max_diff_bytes: 10_000_000,
    include_untracked: [],
    // No diff-stub policy by default: zero-config behavior is byte-identical.
    stub_paths: [],
  },
  archive: {
    enabled: true,
    redact_secrets: false,
  },
  skills: {
    enabled: {},
  },
  naming: {
    prefix: 'orcaops',
  },
  // `managed` matches the zod default. Fresh `orcaops init` overrides this to
  // `manual` — instruction-file injection is opt-in there — so this literal is
  // only ever user-visible through loadConfig's allowMissing fallback in an
  // uninitialized repo.
  bootstrap: 'managed',
  session_hooks: {
    enabled: false,
    payload: 'static',
    entries: 'project',
  },
  generated_files: 'commit',
  workflow: {
    hints: {
      keys: [],
      custom: [],
    },
  },
};

/**
 * Returns a fully-validated default Config (cloned).
 */
export function getDefaultConfig(): Config {
  return ConfigSchema.parse(structuredClone(DEFAULT_CONFIG));
}

/**
 * Deep-merge a partial config over the defaults, then validate.
 * Object fields merge key-by-key; arrays and primitives replace.
 */
export function resolveConfig(partial: unknown): Config {
  if (typeof partial === 'object' && partial !== null && !Array.isArray(partial)) {
    for (const key of ['__proto__', 'constructor', 'prototype']) {
      if (!Object.prototype.hasOwnProperty.call(partial, key)) continue;
      throw new ConfigValidationError(`Unknown root configuration key "${key}".`, key);
    }
  }
  // An accepted predecessor loads to the CURRENT shape — its delta is purely
  // additive and defaulted. Normalize before the merge, which would otherwise
  // overwrite the default version with the older literal and fail the schema.
  const normalized =
    typeof partial === 'object' &&
    partial !== null &&
    !Array.isArray(partial) &&
    ACCEPTED_PREDECESSOR_VERSIONS.includes(
      (partial as Record<string, unknown>).schema_version as number
    )
      ? { ...(partial as Record<string, unknown>), schema_version: CONFIG_SCHEMA_VERSION }
      : partial;
  const merged = deepMergeInto(structuredClone(DEFAULT_CONFIG), normalized);
  const parsed = ConfigSchema.safeParse(merged);
  if (parsed.success) return parsed.data;

  const issue = parsed.error.issues[0];
  const unknownKeys = issue?.code === 'unrecognized_keys' ? issue.keys : [];
  const issuePath =
    [...(issue?.path ?? []), ...unknownKeys.slice(0, 1)].map(String).join('.') || 'config';
  throw new ConfigValidationError(
    `.orcaops/config.json is invalid at ${issuePath}: ${issue?.message ?? 'invalid value'}.`,
    issuePath
  );
}

function deepMergeInto(target: unknown, source: unknown): unknown {
  if (source === undefined || source === null) return target;
  if (
    typeof target !== 'object' ||
    target === null ||
    Array.isArray(target) ||
    typeof source !== 'object' ||
    Array.isArray(source)
  ) {
    return source;
  }
  const out = target as Record<string, unknown>;
  for (const [key, value] of Object.entries(source as Record<string, unknown>)) {
    // Never merge prototype-mutating keys — `JSON.parse` materializes a literal
    // `__proto__` (and `constructor`/`prototype`) as an own-enumerable key, and
    // merging it would pollute `Object.prototype` from an attacker-controlled
    // `.orcaops/config.json` on every `loadConfig`.
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    out[key] = deepMergeInto(out[key], value);
  }
  return out;
}
