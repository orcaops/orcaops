// Build the floor's citation table — every plan step, non-goal, plan decision
// (with its rejected alternatives), acceptance criterion, checkpoint
// decision/uncertainty, done-criterion evidence, verified-close record, summary
// field, and evaluator run in scope, each with a stable `cite:` id and its
// verbatim text. This is the single source the TUI renders and the compose
// skill cites against.

import {
  checkpointRef,
  type Citation,
  CITATION_KIND,
  formatCitationId,
} from '@orcaops/review-core';

import { orderedCheckpoints, type ReviewArtifact } from './model.js';

export interface CitationTable {
  citations: Citation[];
  /** cite ids grouped by `checkpointRef(artifact, n)` — for linking outline checkpoints. */
  byCheckpoint: Map<string, string[]>;
}

export function buildCitations(artifacts: readonly ReviewArtifact[]): CitationTable {
  const citations: Citation[] = [];
  const byCheckpoint = new Map<string, string[]>();

  const pushCp = (ref: string, id: string): void => {
    const list = byCheckpoint.get(ref);
    if (list) list.push(id);
    else byCheckpoint.set(ref, [id]);
  };

  for (const a of artifacts) {
    // Plan steps + their acceptance criteria (artifact-scoped).
    let acceptanceIndex = 0;
    // criterion_id -> the acceptance citation it minted. This is the ONLY link
    // from close-time `done_criteria` evidence back to the plan-time criterion
    // it evidences: the acceptance id's index is a running position across the
    // artifact's steps, so it cannot be recomputed from a criterion_id alone.
    // First declaration wins, so a duplicated id resolves deterministically to
    // the earliest criterion in plan order.
    const acceptanceIdByCriterion = new Map<string, string>();
    a.planSteps.forEach((step, i) => {
      const stepId = formatCitationId({
        artifact: a.id,
        checkpointN: null,
        kind: CITATION_KIND.PLAN_STEP,
        index: i,
      });
      citations.push({
        id: stepId,
        kind: CITATION_KIND.PLAN_STEP,
        artifact: a.id,
        text: step.text,
      });
      for (const crit of step.acceptanceCriteria) {
        const critId = formatCitationId({
          artifact: a.id,
          checkpointN: null,
          kind: CITATION_KIND.ACCEPTANCE_CRITERION,
          index: acceptanceIndex,
        });
        citations.push({
          id: critId,
          kind: CITATION_KIND.ACCEPTANCE_CRITERION,
          artifact: a.id,
          parent: stepId,
          text: crit.text,
        });
        if (!acceptanceIdByCriterion.has(crit.criterionId))
          acceptanceIdByCriterion.set(crit.criterionId, critId);
        acceptanceIndex += 1;
      }
    });

    // Non-goals (artifact-scoped).
    a.nonGoals.forEach((ng, i) => {
      citations.push({
        id: formatCitationId({
          artifact: a.id,
          checkpointN: null,
          kind: CITATION_KIND.PLAN_NON_GOAL,
          index: i,
        }),
        kind: CITATION_KIND.PLAN_NON_GOAL,
        artifact: a.id,
        text: ng.text,
      });
    });

    // Plan-time decisions + their rejected alternatives (artifact-scoped). The
    // plan-mode counterpart of the checkpoint block below, with one structural
    // difference: no `cp` locus, so the alternatives ride their own kind
    // (`formatCitationId` throws for a checkpoint-scoped kind with a null cp).
    // Alternative indices run per ARTIFACT here, matching the per-checkpoint
    // running index the checkpoint block uses.
    let planAlternativeIndex = 0;
    a.planDecisions.forEach((d, i) => {
      const id = formatCitationId({
        artifact: a.id,
        checkpointN: null,
        kind: CITATION_KIND.PLAN_DECISION,
        index: i,
      });
      citations.push({
        id,
        kind: CITATION_KIND.PLAN_DECISION,
        artifact: a.id,
        // Same `\n↳ ` reason marker as every other decision record.
        text: d.reason ? `${d.decision}\n↳ ${d.reason}` : d.decision,
      });
      for (const alt of d.alternativesConsidered) {
        citations.push({
          id: formatCitationId({
            artifact: a.id,
            checkpointN: null,
            kind: CITATION_KIND.PLAN_ALTERNATIVE,
            index: planAlternativeIndex,
          }),
          kind: CITATION_KIND.PLAN_ALTERNATIVE,
          artifact: a.id,
          // The flat per-artifact index cannot say which decision ruled an
          // option out; `parent` is that link, and it is always set here
          // because both records are minted in this one pass.
          parent: id,
          text: alt.rejectedBecause ? `${alt.option}\n↳ ${alt.rejectedBecause}` : alt.option,
        });
        planAlternativeIndex += 1;
      }
    });

    // Summary fields (artifact-scoped).
    const summaryFields = [a.summaryText].filter(
      (t): t is string => typeof t === 'string' && t.length > 0
    );
    summaryFields.forEach((text, i) => {
      citations.push({
        id: formatCitationId({
          artifact: a.id,
          checkpointN: null,
          kind: CITATION_KIND.SUMMARY,
          index: i,
        }),
        kind: CITATION_KIND.SUMMARY,
        artifact: a.id,
        text,
      });
    });

    // Evaluator runs (artifact-scoped).
    a.evaluatorRuns.forEach((run, i) => {
      const head = run.body.split('\n')[0] ?? '';
      citations.push({
        id: formatCitationId({
          artifact: a.id,
          checkpointN: null,
          kind: CITATION_KIND.EVALUATOR_RUN,
          index: i,
        }),
        kind: CITATION_KIND.EVALUATOR_RUN,
        artifact: a.id,
        text: `${run.id} — ${run.verdict ?? run.severity}: ${head}`,
        evaluator: {
          evaluator_ref: run.id,
          severity: run.severity,
          run_status: run.runStatus,
          verdict: run.verdict,
          disposition: run.disposition,
          summary: head,
        },
      });
    });

    // Checkpoint decisions + uncertainty (checkpoint-scoped).
    for (const cp of orderedCheckpoints(a)) {
      const ref = checkpointRef(a.id, cp.n);
      let alternativeIndex = 0;
      cp.decisions.forEach((d, i) => {
        const id = formatCitationId({
          artifact: a.id,
          checkpointN: cp.n,
          kind: CITATION_KIND.CHECKPOINT_DECISION,
          index: i,
        });
        citations.push({
          id,
          kind: CITATION_KIND.CHECKPOINT_DECISION,
          artifact: a.id,
          cp: cp.n,
          // Carry the reason as part of the verbatim decision record — the review
          // rail renders it as the "↳ because" line. `\n↳ ` is a stable marker the
          // view model splits back out; ID-based citation checks are unaffected.
          text: d.reason ? `${d.decision}\n↳ ${d.reason}` : d.decision,
        });
        pushCp(ref, id);
        // Rejected alternatives — RULED-OUT evidence, one citation each with a
        // per-checkpoint running index (same `↳` marker convention). Floor
        // transport only: consumers that don't know the kind ignore it.
        // `parent` carries the enclosing decision's id: the capture nests
        // alternatives under a decision, and without the back-reference the
        // flat per-checkpoint list cannot be re-attached to the decision the
        // agent actually ruled them out for.
        for (const alt of d.alternativesConsidered) {
          const altId = formatCitationId({
            artifact: a.id,
            checkpointN: cp.n,
            kind: CITATION_KIND.CHECKPOINT_ALTERNATIVE,
            index: alternativeIndex,
          });
          citations.push({
            id: altId,
            kind: CITATION_KIND.CHECKPOINT_ALTERNATIVE,
            artifact: a.id,
            cp: cp.n,
            parent: id,
            text: alt.rejectedBecause ? `${alt.option}\n↳ ${alt.rejectedBecause}` : alt.option,
          });
          pushCp(ref, altId);
          alternativeIndex += 1;
        }
      });
      cp.uncertainty.forEach((u, i) => {
        const id = formatCitationId({
          artifact: a.id,
          checkpointN: cp.n,
          kind: CITATION_KIND.CHECKPOINT_UNCERTAINTY,
          index: i,
        });
        citations.push({
          id,
          kind: CITATION_KIND.CHECKPOINT_UNCERTAINTY,
          artifact: a.id,
          cp: cp.n,
          text: u,
        });
        pushCp(ref, id);
      });
      // Done-criteria evidence: what close claims was delivered for one
      // plan-time acceptance criterion. `parent` is the ACCEPTANCE_CRITERION
      // citation the `criterion_id` resolves to — matched through the map the
      // plan-step pass built, since the acceptance id's index is a running
      // position and cannot be derived from a criterion_id.
      //
      // A criterion_id that resolves to NOTHING in scope (a criterion a later
      // plan revision dropped, or evidence for another artifact's plan) leaves
      // `parent` absent and the evidence rides anyway — dropping captured
      // evidence to preserve a tidy link is the failure mode this whole
      // surface exists to prevent. The criterion_id therefore stays in the
      // text, so an unparented record still says what it evidences.
      cp.doneCriteria.forEach((dc, i) => {
        const id = formatCitationId({
          artifact: a.id,
          checkpointN: cp.n,
          kind: CITATION_KIND.CRITERION_EVIDENCE,
          index: i,
        });
        const parent = acceptanceIdByCriterion.get(dc.criterionId);
        citations.push({
          id,
          kind: CITATION_KIND.CRITERION_EVIDENCE,
          artifact: a.id,
          cp: cp.n,
          ...(parent !== undefined ? { parent } : {}),
          text: `${dc.criterionId} — ${dc.evidence}`,
        });
        pushCp(ref, id);
      });
      // Verified-close evidence: the command, its exit code, and any digest or
      // note. A non-zero exit is honest evidence and is carried verbatim — the
      // floor never filters proof by whether it passed.
      cp.verification.forEach((v, i) => {
        const id = formatCitationId({
          artifact: a.id,
          checkpointN: cp.n,
          kind: CITATION_KIND.CHECKPOINT_VERIFICATION,
          index: i,
        });
        const head = `${v.command} → exit ${v.exitCode}${
          v.outputDigest !== null ? ` · ${v.outputDigest}` : ''
        }`;
        citations.push({
          id,
          kind: CITATION_KIND.CHECKPOINT_VERIFICATION,
          artifact: a.id,
          cp: cp.n,
          text: v.note !== null ? `${head}\n↳ ${v.note}` : head,
        });
        pushCp(ref, id);
      });
    }
  }

  return { citations, byCheckpoint };
}
