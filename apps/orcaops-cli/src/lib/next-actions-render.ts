import type { SemanticAction } from '@orcaops/core';

import { blockScalar, captureHeredoc, flowSeq } from './yaml-emit.js';

/**
 * Public, agent-facing shape of a next-step hint. Matches the inline
 * `next_actions` arrays in `resume` and the test-harness type.
 */
export interface RenderedNextAction {
  verb: string;
  command: string;
  effect: string;
}

/**
 * Render core's semantic actions into concrete `orcaops …` command strings.
 *
 * Capture verbs render a `--input -` YAML heredoc — the only capture input
 * surface (the parser accepts YAML, a JSON superset). The body is built from plain objects and serialized by the
 * shared `yaml-emit` helper (backed by the `yaml` library), so real values are
 * quoted by construction and prose placeholders render as `|-` block scalars —
 * no hand-built `k: v` lines. This mirrors the adapters skill heredocs; the
 * skill cross-check in next-actions-render.test.ts ties the renderer to those
 * bodies so the surface can't silently drift. Block verbs render flags
 * (`--evaluator/--run-id/--reason`); digest renders a flag form.
 */
export function renderNextActions(actions: readonly SemanticAction[]): RenderedNextAction[] {
  return actions.map((a) => ({ verb: a.verb, command: renderCommand(a), effect: a.effect }));
}

function renderCommand(a: SemanticAction): string {
  const id = a.artifact_id;
  switch (a.verb) {
    case 'checkpoint-open': {
      // Pre-append open rejection → a remediation TEMPLATE, never a verbatim
      // re-run of the rejected scope (that would re-hit the same block).
      if (a.retry_reason === 'open-rejected') {
        const body: Record<string, unknown> = {
          artifact_id: id,
          declared_step_ids: flowSeq(['<smaller-step-subset>']),
        };
        if (a.policy_exception_refs && a.policy_exception_refs.length > 0) {
          body.policy_exceptions = a.policy_exception_refs.map((ref) => ({
            evaluator: ref,
            reason: blockScalar('<why this scope is intentional>'),
          }));
        }
        return captureHeredoc('checkpoint open', body);
      }
      const ids = a.step_ids ?? [];
      return captureHeredoc('checkpoint open', {
        artifact_id: id,
        // More than one uncovered step → a CHOOSE-A-SUBSET template, not a
        // paste-the-max command (which would anchor the agent to an over-broad
        // checkpoint, and could be exactly what the checkpoint-scope-density
        // gate then rejects). A single — or defensively empty — action keeps its
        // real declared_step_ids so the common next-step open stays
        // verbatim-runnable. `> 1` (not `=== 1`) so a 0-length action renders
        // `[]`, never a fabricated placeholder.
        declared_step_ids: ids.length > 1 ? flowSeq(['<next-coherent-subset>']) : flowSeq(ids),
      });
    }

    case 'checkpoint-close':
      return captureHeredoc('checkpoint close', {
        artifact_id: id,
        n: a.checkpoint_n,
        summary: blockScalar('<what changed and why>'),
        completed_step_ids: flowSeq(a.step_ids ?? []),
      });

    case 'checkpoint-abandon':
      return captureHeredoc('checkpoint abandon', {
        artifact_id: id,
        n: a.checkpoint_n,
        reason: blockScalar('<why this checkpoint is being abandoned>'),
      });

    case 'finish':
      return `orcaops finish --input - <<'EOF'\nartifact_id: ${id}\noutcome: |-\n  <what shipped and the outcome>\nEOF`;

    case 'digest':
      return `orcaops digest --artifact ${id}`;

    case 'evaluator-rerun':
      if (a.evaluator_phase === 'pre-pr') {
        return captureHeredoc('pre-pr-check', { artifact_id: id });
      }
      return captureHeredoc('run-evaluators', {
        idempotency_key: '<fresh-idempotency-key>',
        artifact_id: id,
        fires_at: a.evaluator_phase,
        ...(a.checkpoint_n === undefined ? {} : { checkpoint_n: a.checkpoint_n }),
      });

    case 'block-acknowledge':
      return blockCommand('acknowledge', a, 'why you accept this finding');

    case 'block-dismiss':
      return blockCommand('dismiss', a, 'why this is a false positive');
  }
}

function blockCommand(
  sub: 'acknowledge' | 'dismiss',
  a: SemanticAction,
  reasonHint: string
): string {
  const parts = [
    `orcaops block ${sub}`,
    `--artifact ${a.artifact_id}`,
    `--evaluator ${a.evaluator_ref ?? '<evaluator-ref>'}`,
  ];
  if (a.run_id) parts.push(`--run-id ${a.run_id}`);
  parts.push(`--reason "<${reasonHint}>"`);
  return parts.join(' ');
}
