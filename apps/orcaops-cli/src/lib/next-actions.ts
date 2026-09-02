import { deriveLifecycleSnapshot, nextActions, type SemanticAction } from '@orcaops/core';
import { discoverEvaluators } from '@orcaops/evaluator-runner';

import type { CliContext } from './context.js';
import { CLI_ROOT } from './evaluators-config.js';
import { type RenderedNextAction, renderNextActions } from './next-actions-render.js';
import type { OpenRejectionEnvelope } from '../io/errors.js';

export interface NextActionsOptions {
  /** Pre-fetched HEAD sha — pass once when computing for many artifacts (status). */
  currentHeadSha?: string;
  /** ref → acknowledge-eligible. Pass to avoid per-artifact discovery; absent ⇒ lazy. */
  acknowledgeByRef?: (ref: string) => boolean;
}

/**
 * `ref → acknowledge-eligible` from a discovered evaluator set: a ref is
 * ack-eligible iff it is block-severity AND opts into
 * `resolution.acknowledge.enabled`. The single definition of that predicate,
 * shared by `discoverAcknowledgeByRef` and the `block acknowledge`/`dismiss`
 * commands so the eligibility rule lives in one place.
 */
export function buildAcknowledgeByRef(
  evaluators: readonly {
    ref: string;
    severity: string;
    resolution: { acknowledge: { enabled: boolean } };
  }[]
): (ref: string) => boolean {
  const map = new Map<string, boolean>();
  for (const e of evaluators) {
    map.set(e.ref, e.severity === 'block' && e.resolution.acknowledge.enabled);
  }
  return (ref) => map.get(ref) === true;
}

/**
 * Build the ack-eligibility lookup from the configured evaluator packs.
 * Inspection-mode discovery (errors swallowed) so a broken spec elsewhere can't
 * blow up a hint.
 */
export async function discoverAcknowledgeByRef(ctx: CliContext): Promise<(ref: string) => boolean> {
  const { evaluators } = await discoverEvaluators(ctx.repoRoot, {
    cliRoot: CLI_ROOT,
    onError: () => undefined,
  });
  return buildAcknowledgeByRef(evaluators);
}

/**
 * Compute rendered next-step hints for an artifact. Never throws — returns
 * `[]` on any failure so a hint can't break the command it rides on.
 *
 * Lazy ack-enrichment: when the snapshot has unresolved blocks and no
 * `acknowledgeByRef` was supplied, discover once and enrich
 * `acknowledge_enabled` in place BEFORE `nextActions` (the first derivation
 * defaults it to false). Discovery failure degrades to dismiss-only.
 */
export async function renderedNextActionsForArtifact(
  ctx: CliContext,
  artifactId: string,
  opts: NextActionsOptions = {}
): Promise<RenderedNextAction[]> {
  try {
    let snapshot = await deriveLifecycleSnapshot(ctx.store, ctx.repo, artifactId, {
      currentHeadSha: opts.currentHeadSha,
      acknowledgeByRef: opts.acknowledgeByRef,
    });
    if (!snapshot) return [];

    // Lazy ack-enrichment, INTENTIONALLY two-pass: derive once (cheap), then
    // discover evaluator ack-eligibility ONLY when there are unresolved blocks
    // and no lookup was supplied. Do NOT hoist discovery into the derive call —
    // discoverEvaluators globs + parses every pack, and the common path is
    // unblocked, so eager discovery would tax every capture/status/resume hint
    // Discovery failure degrades to dismiss-only, never drops hints.
    if (snapshot.unresolved_blocks.length > 0 && !opts.acknowledgeByRef) {
      let ackByRef: (ref: string) => boolean;
      try {
        ackByRef = await discoverAcknowledgeByRef(ctx);
      } catch {
        ackByRef = () => false; // broken evaluator config → dismiss-only, never drop hints
      }
      snapshot = {
        ...snapshot,
        unresolved_blocks: snapshot.unresolved_blocks.map((b) => ({
          ...b,
          acknowledge_enabled: b.kind === 'violation' && ackByRef(b.evaluator_ref),
        })),
      };
    }

    return renderNextActions(nextActions(snapshot));
  } catch {
    return [];
  }
}

/**
 * A pre-append `checkpoint open` rejection (`checkpoint-scope-density` etc.)
 * is a soft block with no persisted run — the snapshot won't show it. Build a
 * remediation TEMPLATE straight off the blocked envelope (the attempted scope
 * + the blocked refs), never a verbatim re-run of the rejected scope.
 */
function openRejectionAction(env: OpenRejectionEnvelope): SemanticAction {
  const refs = env.blocked_evaluator_refs;
  const declared = env.declared_step_ids;
  const refList = refs.length > 0 ? refs.join(', ') : 'an evaluator';
  return {
    verb: 'checkpoint-open',
    artifact_id: env.artifact_id,
    retry_reason: 'open-rejected',
    policy_exception_refs: refs,
    effect:
      `Open was rejected pre-append by ${refList}. Re-open with a SMALLER subset of the ` +
      `rejected step(s) [${declared.join(', ')}], or keep the scope and add the ` +
      `policy_exceptions[] shown (each named evaluator must opt into inline exceptions).`,
  };
}

/**
 * Runtime guard for the pre-append open-rejection envelope. Validates the
 * shape the typed producer (checkpoint.ts) emits so `openRejectionAction` reads
 * it directly — the field coupling is now a compile-time contract, not a
 * convention over an untyped record.
 */
function isOpenRejectionEnvelope(
  result: Record<string, unknown>
): result is Record<string, unknown> & OpenRejectionEnvelope {
  return (
    result.status === 'blocked' &&
    result.gate_audit !== undefined &&
    typeof result.artifact_id === 'string' &&
    Array.isArray(result.declared_step_ids) &&
    Array.isArray(result.blocked_evaluator_refs)
  );
}

/**
 * Attach `next_actions` to a capture/command result. Best-effort: never
 * throws, leaving the result untouched on any failure.
 *
 * Two paths:
 *   1. A pre-append checkpoint-open rejection (`status: 'blocked'` +
 *      `gate_audit`) → a remediation template from the envelope.
 *   2. Otherwise, snapshot-derived hints for `result.artifact_id`.
 */
export async function appendNextActions<T extends Record<string, unknown>>(
  ctx: CliContext,
  result: T,
  opts: NextActionsOptions = {}
): Promise<T> {
  try {
    if (isOpenRejectionEnvelope(result)) {
      const action = openRejectionAction(result);
      return { ...result, next_actions: renderNextActions([action]) };
    }
    const artifactId = typeof result.artifact_id === 'string' ? result.artifact_id : null;
    if (!artifactId) return result;
    const next_actions = await renderedNextActionsForArtifact(ctx, artifactId, opts);
    // The approval track lives in a gate-materialized skill, so a freshly
    // captured plan carries a RUNTIME hint toward it: per-machine output may
    // name the cloud; shared committed files must not. Scoped to plan
    // capture/revise responses (`plan_steps`), and silent when the plan is
    // already pinned to a reviewed cloud version.
    const sourcePlanKind = (result as { source_plan?: { source_ref?: { kind?: string } } | null })
      .source_plan?.source_ref?.kind;
    if (ctx.gates.cloud && Array.isArray(result.plan_steps) && sourcePlanKind !== 'cloud') {
      next_actions.push({
        verb: 'plan-approval',
        command: 'orcaops plan upload <plan-file> --json',
        effect:
          'This machine is cloud-connected and the plan is not pinned to a reviewed cloud ' +
          'version. To route it through web approval, upload it, then follow the ' +
          'plan-approval skill to pull the approved version and re-capture with ' +
          '--source-plan cloud:<id>@<n>.',
      });
    }
    return { ...result, next_actions };
  } catch {
    return result;
  }
}
