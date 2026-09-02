import { run } from 'effection';

import {
  probeProviderAvailability,
  type ProviderProbeSnapshot,
  selectDefaultProvider,
} from '@orcaops/llm';

import { CliExit } from '../../io/exit.js';
import {
  emitError,
  emitOk,
  writeErrorLine,
  writeTerminalSafeStderr,
  writeTerminalSafeStdout,
} from '../../io/output.js';
import { buildContext } from '../../lib/context.js';
import { discoverEvaluatorsForCli } from '../../lib/evaluator-discovery.js';
import { getInvocationCwd, getInvocationEnv } from '../../lib/invocation-context.js';

export interface EvalListOptions {
  json?: boolean;
  /** Exit non-zero when any discovery error was suppressed. */
  strict?: boolean;
}

interface EvaluatorSummary {
  ref: string;
  package_id: string;
  evaluator_id: string;
  severity: 'info' | 'warn' | 'block';
  phase: 'post-plan' | 'post-plan-revision' | 'checkpoint-open' | 'checkpoint-close' | 'pre-pr';
  engine: 'command' | 'llm';
  enabled: boolean;
  filters: { paths: string[]; scopes: string[]; when_llm: string };
  allows_acknowledge?: boolean;
  allows_policy_exception?: boolean;
  llm?: {
    provider: {
      value: 'auto' | 'claude' | 'codex' | 'none';
      source: 'user-override' | 'pack-spec' | 'global';
      available: boolean | null;
    };
    model: {
      value: string | null;
      source: 'user-override' | 'pack-spec' | 'global' | 'provider-default';
    };
    timeout_ms: {
      value: number;
      source: 'user-override' | 'pack-spec' | 'pack-default';
    };
  };
}

/**
 * `orcaops eval list` — enumerate every discovered evaluator across
 * the configured packs. Lenient mode: per-spec / per-pack discovery
 * errors are silently dropped so misconfigured specs don't hide
 * working ones (doctor surfaces those errors separately).
 */
export async function evalListAction(opts: EvalListOptions = {}): Promise<void> {
  try {
    const ctx = await buildContext({ mintArchiveIdentity: false });
    try {
      const { evaluators, errors } = await discoverEvaluatorsForCli(ctx.repoRoot);
      const providerSnapshot =
        ctx.config.llm.tool === 'none'
          ? ({ claude: 'absent', codex: 'absent' } satisfies ProviderProbeSnapshot)
          : await run(() =>
              probeProviderAvailability({
                env: getInvocationEnv(),
                cwd: getInvocationCwd(),
              })
            );
      const defaultProvider = selectDefaultProvider(ctx.config.llm.tool, providerSnapshot);

      const summary: EvaluatorSummary[] = evaluators.map((e) => {
        const effectiveProvider =
          e.engine.kind === 'llm' ? (e.engine.provider ?? defaultProvider) : null;
        return {
          ref: e.ref,
          package_id: e.package_id,
          evaluator_id: e.evaluator_id,
          severity: e.severity,
          phase: e.phase,
          engine: e.engine.kind,
          enabled: e.enabled,
          filters: {
            paths: e.filters.paths,
            scopes: e.filters.scopes,
            when_llm: e.filters.when_llm,
          },
          ...(e.engine.kind === 'llm'
            ? {
                llm: {
                  provider: {
                    value: effectiveProvider ?? 'none',
                    source: e.engine.selection_sources?.provider ?? 'global',
                    available:
                      effectiveProvider === null || ctx.config.llm.tool === 'none'
                        ? null
                        : providerSnapshot[effectiveProvider] === 'unverified'
                          ? null
                          : providerSnapshot[effectiveProvider] === 'present',
                  },
                  model: {
                    value:
                      e.engine.selection_sources?.model === 'global'
                        ? ctx.config.llm.model
                        : (e.engine.model ?? null),
                    source:
                      e.engine.selection_sources?.model === 'global'
                        ? ctx.config.llm.model === null
                          ? 'provider-default'
                          : 'global'
                        : (e.engine.selection_sources?.model ?? 'provider-default'),
                  },
                  timeout_ms: {
                    value: e.engine.timeout_ms,
                    source: e.engine.selection_sources?.timeout_ms ?? 'pack-default',
                  },
                },
              }
            : {}),
          ...(e.severity === 'block'
            ? {
                allows_acknowledge: e.resolution.acknowledge.enabled,
                allows_policy_exception: e.resolution.policy_exception.enabled,
              }
            : {}),
        };
      });

      if (opts.json) {
        emitOk({
          evaluators: summary,
          errors: errors.map((e) => ({
            source_path: e.source_path,
            field_path: e.field_path,
            message: e.message,
          })),
        });
        if (opts.strict && errors.length > 0) {
          throw new CliExit(2);
        }
        return;
      }

      if (summary.length === 0 && errors.length === 0) {
        writeTerminalSafeStdout(
          `No evaluators discovered. Run \`orcaops eval add-pack @orcaops/evaluator-pack core\` to install the default first-party pack.\n`
        );
        return;
      }
      if (summary.length > 0) {
        writeTerminalSafeStdout(formatHumanList(summary));
      }
      if (errors.length > 0) {
        writeTerminalSafeStderr(
          `\n⚠ ${errors.length} evaluator discovery problem(s); run \`orcaops doctor\` for details.\n`
        );
        if (opts.strict) {
          throw new CliExit(2);
        }
      }
    } finally {
      ctx.store.close();
    }
  } catch (err) {
    if (err instanceof CliExit) throw err;
    if (opts.json) emitError(err);
    writeErrorLine(err);
    throw new CliExit(1);
  }
}

function formatHumanList(rows: EvaluatorSummary[]): string {
  const lines: string[] = [];
  lines.push(`SEVERITY  PHASE              ENGINE   ENABLED  REF`);
  for (const r of rows) {
    const severity = r.severity.padEnd(9);
    const phase = r.phase.padEnd(18);
    const engine = r.engine.padEnd(8);
    const enabled = (r.enabled ? 'yes' : 'no').padEnd(8);
    lines.push(`${severity} ${phase} ${engine} ${enabled} ${r.ref}`);
    if (r.llm) {
      const model = r.llm.model.value ?? 'provider default';
      lines.push(
        `          LLM provider=${r.llm.provider.value} (${r.llm.provider.source}), ` +
          `available=${r.llm.provider.available === null ? (r.llm.provider.value === 'none' ? 'n/a' : 'unknown') : r.llm.provider.available ? 'yes' : 'no'}, ` +
          `model=${model} (${r.llm.model.source}), ` +
          `timeout=${r.llm.timeout_ms.value}ms (${r.llm.timeout_ms.source})`
      );
    }
  }
  lines.push('');
  return lines.join('\n');
}
