import { z } from 'zod';
export const EvaluatorPhaseSchema = z.enum([
  'post-plan',
  'post-plan-revision',
  'checkpoint-open',
  'checkpoint-close',
  'pre-pr',
]);
export type EvaluatorPhase = z.infer<typeof EvaluatorPhaseSchema>;
export const EvaluatorSeveritySchema = z.enum(['info', 'warn', 'block']);
export type EvaluatorSeverity = z.infer<typeof EvaluatorSeveritySchema>;
export const EvaluatorEngineKindSchema = z.enum(['command', 'llm']);
export type EvaluatorEngineKind = z.infer<typeof EvaluatorEngineKindSchema>;
export const LlmOutputFormatSchema = z.enum(['markdown', 'json']);
export type LlmOutputFormat = z.infer<typeof LlmOutputFormatSchema>;
export const LlmEffortSchema = z.enum(['low', 'medium', 'high', 'xhigh', 'max']);
export type LlmEffort = z.infer<typeof LlmEffortSchema>;
export const LlmProviderSchema = z.enum(['claude', 'codex']);
export type LlmProvider = z.infer<typeof LlmProviderSchema>;
export const ContextSectionSchema = z.enum([
  'acceptance-criteria',
  'delivered-checkpoints',
  'diff-boundary',
  'source-plan',
]);
export type ContextSection = z.infer<typeof ContextSectionSchema>;
export const WhenLlmSchema = z.enum(['required', 'absent', 'optional']);
export type WhenLlm = z.infer<typeof WhenLlmSchema>;
export const EngineCwdSchema = z.enum(['package', 'repo']);
export type EngineCwd = z.infer<typeof EngineCwdSchema>;
export const EvaluatorRunStatusSchema = z.enum(['completed', 'error', 'skipped']);
export type EvaluatorRunStatus = z.infer<typeof EvaluatorRunStatusSchema>;
export const EvaluatorVerdictSchema = z.enum(['pass', 'violation', 'info']);
export type EvaluatorVerdict = z.infer<typeof EvaluatorVerdictSchema>;
export const EvaluatorDispositionSchema = z.enum([
  'unresolved',
  'acknowledged',
  'dismissed',
  'policy-excepted',
]);
export type EvaluatorDisposition = z.infer<typeof EvaluatorDispositionSchema>;
export const WrittenDispositionSchema = z.enum(['acknowledged', 'dismissed', 'policy-excepted']);
export type WrittenDisposition = z.infer<typeof WrittenDispositionSchema>;
export const LlmTokenUsageSchema = z
  .object({
    in: z.number().int().nonnegative(),
    out: z.number().int().nonnegative(),
    cache_read: z.number().int().nonnegative().optional(),
    cache_write: z.number().int().nonnegative().optional(),
  })
  .strict();
export type LlmTokenUsage = z.infer<typeof LlmTokenUsageSchema>;
export const EvaluatorRunErrorSchema = z
  .object({
    code: z.string().min(1),
    message: z.string(),
  })
  .strict();
export type EvaluatorRunError = z.infer<typeof EvaluatorRunErrorSchema>;
export const IdPatternRegex = /^[a-z0-9][a-z0-9-]*$/;
export const IdSchema = z.string().min(1);
