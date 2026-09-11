import { z } from 'zod';

export { DEFAULT_CAPTURE_EXCLUDE } from '../../protocol/index.js';
import { ConfigValidationError } from './validation.js';
import { assertSafeRelativePath } from '../paths/containment.js';
export const DEFAULT_EVALUATOR_MODEL = 'claude-sonnet-4-6';
const RepoRelativePathSchema = z.string().superRefine((value, ctx) => {
  try {
    assertSafeRelativePath(value, 'path');
  } catch (err) {
    ctx.addIssue({ code: 'custom', message: (err as Error).message });
  }
});
export const CONFIG_SCHEMA_VERSION = 6;
const ACCEPTED_PREDECESSOR_VERSIONS: readonly number[] = [5];
export function isAcceptedConfigVersion(version: unknown): boolean {
  return (
    version === CONFIG_SCHEMA_VERSION ||
    (typeof version === 'number' && ACCEPTED_PREDECESSOR_VERSIONS.includes(version))
  );
}
export function assertConfigVersionCurrent(raw: unknown): void {
  const v =
    raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>).schema_version
      : undefined;
  if (v === CONFIG_SCHEMA_VERSION) return;
  if (typeof v === 'number' && ACCEPTED_PREDECESSOR_VERSIONS.includes(v)) return;
  if (typeof v === 'string') {
    throw new ConfigValidationError(
      `orcaops configuration: schema_version must be the number ${CONFIG_SCHEMA_VERSION}, ` +
        `got the string "${v}" — edit it to an unquoted ${CONFIG_SCHEMA_VERSION}, or run ` +
        '`orcaops init --force --reset-config` to restore current defaults.',
      'schema_version'
    );
  }
  if (typeof v === 'number' && v > CONFIG_SCHEMA_VERSION) {
    throw new ConfigValidationError(
      `orcaops configuration: schema_version is ${v}, but this orcaops only understands ` +
        `up to ${CONFIG_SCHEMA_VERSION}. Upgrade orcaops (or check out a newer build).`,
      'schema_version'
    );
  }
  const shown = typeof v === 'number' ? String(v) : 'missing';
  throw new ConfigValidationError(
    `orcaops configuration: schema_version is ${shown}, but this orcaops requires ` +
      `${CONFIG_SCHEMA_VERSION}. Re-run \`orcaops init --force --reset-config\` to regenerate the config ` +
      `(or hand-edit it to the current v${CONFIG_SCHEMA_VERSION} shape) and retry.`,
    'schema_version'
  );
}
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
export const CURATED_HINT_KEYS = [
  'commit-on-checkpoint-close',
  'open-checkpoint-before-edits',
  'capture-on-nontrivial',
  'subagent-parallelism',
  'checkpoint-cadence',
] as const;
export type HintKey = (typeof CURATED_HINT_KEYS)[number];
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
export const ConfigSchema = z.strictObject({
  schema_version: z.literal(CONFIG_SCHEMA_VERSION),
  install: z
    .strictObject({
      agents: z.array(z.enum(SUPPORTED_AGENT_IDS)).default([]),
      scope: z.enum(['project', 'global', 'personal']).default('project'),
      link: z.enum(['copy', 'symlink']).default('copy'),
    })
    .default({ agents: [], scope: 'project', link: 'copy' }),
  llm: z.strictObject({
    tool: z.enum(['auto', 'claude', 'codex', 'none']),
    model: z.string().min(1).nullable(),
    effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']),
    default_max_cost_usd: z.number().positive(),
  }),
  artifacts: z.strictObject({
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
  gc: z.strictObject({
    retention_days: z.number().int().positive(),
  }),
  capture: z
    .strictObject({
      exclude: z.array(z.string().min(1)).default([]),
      exclude_builtins: z.boolean().default(true),
    })
    .default({ exclude: [], exclude_builtins: true }),
  redact: z
    .strictObject({
      allow: z.array(z.string().min(1)).default([]),
    })
    .default({ allow: [] }),
  diff_fingerprint: z.strictObject({
    enabled: z.boolean().default(true),
    max_diff_bytes: z.number().int().positive().default(2000000),
  }),
  review: z
    .strictObject({
      max_diff_bytes: z.number().int().positive().default(10000000),
      include_untracked: z.array(z.string().min(1)).default([]),
      stub_paths: z.array(z.string()).default([]),
    })
    .default({ max_diff_bytes: 10000000, include_untracked: [], stub_paths: [] }),
  archive: z
    .strictObject({
      enabled: z.boolean().default(true),
      redact_secrets: z.boolean().default(false),
    })
    .default({ enabled: true, redact_secrets: false }),
  skills: z
    .strictObject({
      enabled: z.partialRecord(z.enum(SKILL_IDS), z.boolean()).default({}),
    })
    .default({ enabled: {} }),
  naming: z
    .strictObject({
      prefix: z
        .string()
        .regex(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/, 'prefix must be lowercase and hyphen-safe')
        .default('orcaops'),
    })
    .default({ prefix: 'orcaops' }),
  bootstrap: z.enum(['managed', 'manual']).default('managed'),
  session_hooks: z
    .strictObject({
      enabled: z.boolean().default(false),
      payload: z.enum(['static', 'state-aware']).default('static'),
      entries: z.enum(['project', 'none']).default('project'),
    })
    .default({ enabled: false, payload: 'static', entries: 'project' }),
  generated_files: z.enum(['commit', 'ignore']).default('commit'),
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
    max_diff_bytes: 2000000,
  },
  review: {
    max_diff_bytes: 10000000,
    include_untracked: [],
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
export function getDefaultConfig(): Config {
  return ConfigSchema.parse(structuredClone(DEFAULT_CONFIG));
}
export function resolveConfig(partial: unknown): Config {
  if (typeof partial === 'object' && partial !== null && !Array.isArray(partial)) {
    for (const key of ['__proto__', 'constructor', 'prototype']) {
      if (!Object.prototype.hasOwnProperty.call(partial, key)) continue;
      throw new ConfigValidationError(`Unknown root configuration key "${key}".`, key);
    }
  }
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
    `orcaops configuration is invalid at ${issuePath}: ${issue?.message ?? 'invalid value'}.`,
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
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    out[key] = deepMergeInto(out[key], value);
  }
  return out;
}
