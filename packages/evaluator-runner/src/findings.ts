import {
  boundEvaluatorFindings,
  type EvaluatorFinding,
  type EvaluatorFindingLocation,
  type EvaluatorFindingsUnreadable,
  type EvaluatorRunFindingsOutcome,
  EvaluatorRunFindingsSchema,
  type EvaluatorRunPayload,
  FINDINGS_UNREADABLE_SCHEMA,
  type FindingsRead,
  MAX_FINDING_DETAIL_CHARS,
  RUN_FINDINGS_SCHEMA,
} from '@orcaops/evaluator-protocol';
import {
  scrubEvaluatorDiagnosticAndBound,
  scrubEvaluatorOutput,
} from '@orcaops/evaluator-protocol/secrets';

/**
 * What an engine produces: the run payload, unchanged, and what became of the
 * findings the producer offered.
 *
 * The findings sit BESIDE the payload rather than inside it, because
 * `orcaops.evaluator_run/v1` is strict, is re-parsed on every thread rebuild,
 * is embedded in `checkpoint_opened.gate_audit.runs[]` and is mirrored to an
 * externally owned cloud shape. A caller that only wants the run reads `run`
 * and cannot carry a finding into any of those by accident.
 */
export interface EvaluatorEngineRun {
  run: EvaluatorRunPayload;
  findings: EvaluatorRunFindingsOutcome;
}

/**
 * Turn what a producer offered as findings into the one handover the run
 * carries, so the two paths findings arrive on — the envelope field and the
 * markdown block — cannot come to different conclusions about them.
 *
 * Nothing here can change the verdict, the run status or the gate. The worst
 * outcome is an `unreadable` record saying something was offered and could
 * not be established, which is not a finding and not a pass.
 */
export function packRunFindings(opts: {
  run_id: string;
  source: EvaluatorFindingsUnreadable['source'];
  read: FindingsRead;
}): EvaluatorRunFindingsOutcome {
  if (opts.read.status === 'absent') return { status: 'none' };
  if (opts.read.status === 'unreadable') {
    return unreadable(opts.run_id, opts.source, opts.read.reason);
  }

  // Scrub BEFORE bounding, never after: redaction can lengthen a string, and
  // a secret straddling the cut would otherwise survive as an unmatched
  // prefix. `redactSecretsAndBound` orders the same two steps the same way.
  const scrubbed = opts.read.findings.map(scrubFinding);
  const bounded = boundEvaluatorFindings(scrubbed);
  if (bounded.findings.length === 0) return { status: 'none' };

  // Redaction is the one step that can leave a finding the schema refuses: a
  // key or an id with a secret in it comes back carrying the marker's
  // brackets, and a redacted identifier names something other than what the
  // producer named. There is nothing honest to retain, so it joins the
  // findings that could not be established rather than being quietly reshaped.
  const record = EvaluatorRunFindingsSchema.safeParse({
    schema: RUN_FINDINGS_SCHEMA,
    run_id: opts.run_id,
    findings: bounded.findings,
    ...(bounded.notice !== undefined ? { notice: bounded.notice } : {}),
  });
  if (!record.success) {
    const issue = record.error.issues[0];
    return unreadable(
      opts.run_id,
      opts.source,
      `findings did not survive scrubbing — ${issue.path.join('.') || '<root>'}: ${issue.message}`
    );
  }
  return { status: 'established', record: record.data };
}

function unreadable(
  run_id: string,
  source: EvaluatorFindingsUnreadable['source'],
  reason: string
): EvaluatorRunFindingsOutcome {
  const detail = scrubEvaluatorDiagnosticAndBound(reason, MAX_FINDING_DETAIL_CHARS);
  return {
    status: 'unreadable',
    record: {
      schema: FINDINGS_UNREADABLE_SCHEMA,
      run_id,
      source,
      // The reason is producer-derived, so scrubbing can empty it; the record
      // still has to say that something was offered and failed.
      detail: detail.length > 0 ? detail : 'findings could not be read',
    },
  };
}

/**
 * Every string a finding carries crosses the same trust boundary as `body`:
 * terminal formatting stripped, secrets redacted, exactly as the run's
 * `body`, `raw` and `metrics` already are.
 */
function scrubFinding(finding: EvaluatorFinding): EvaluatorFinding {
  return {
    ...(finding.key !== undefined ? { key: scrubEvaluatorOutput(finding.key) } : {}),
    title: scrubEvaluatorOutput(finding.title),
    ...(finding.detail !== undefined ? { detail: scrubEvaluatorOutput(finding.detail) } : {}),
    ...(finding.locations !== undefined ? { locations: finding.locations.map(scrubLocation) } : {}),
    ...(finding.conclusion !== undefined ? { conclusion: finding.conclusion } : {}),
  };
}

function scrubLocation(location: EvaluatorFindingLocation): EvaluatorFindingLocation {
  switch (location.kind) {
    case 'file':
      return {
        kind: 'file',
        path: scrubEvaluatorOutput(location.path),
        ...(location.start_line !== undefined ? { start_line: location.start_line } : {}),
        ...(location.end_line !== undefined ? { end_line: location.end_line } : {}),
        ...(location.revision !== undefined
          ? { revision: scrubEvaluatorOutput(location.revision) }
          : {}),
      };
    case 'plan-step':
      return { kind: 'plan-step', step_id: scrubEvaluatorOutput(location.step_id) };
    case 'acceptance-criterion':
      return {
        kind: 'acceptance-criterion',
        criterion_id: scrubEvaluatorOutput(location.criterion_id),
      };
    case 'requirement':
      return { kind: 'requirement', revision_id: scrubEvaluatorOutput(location.revision_id) };
    case 'decision':
      return { kind: 'decision', revision_id: scrubEvaluatorOutput(location.revision_id) };
  }
}
