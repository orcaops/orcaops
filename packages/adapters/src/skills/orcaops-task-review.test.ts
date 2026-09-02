import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { orcaopsTaskReviewSkill } from './orcaops-task-review.js';

describe('task-review routine two-lens program', () => {
  const body =
    typeof orcaopsTaskReviewSkill.body === 'function'
      ? orcaopsTaskReviewSkill.body('orcaops')
      : orcaopsTaskReviewSkill.body;

  it('teaches only the composite lifecycle, in program order, with no env gate', () => {
    // The retired ORCAOPS_TWOLANE prefix must never come back: the positive
    // substring checks below pass either way, so the not-contains guard is
    // the discriminating assertion.
    expect(body).not.toContain('ORCAOPS_TWOLANE');
    expect(body).toContain(
      "orcaops review routine-start --branch <b> [--execution-profile-json '<json>'] --json"
    );
    expect(body).toContain(
      "orcaops review routine-submit --branch <b> --run <run-id> --lane forensic --isolation sequential --input - --json <<'EOF'"
    );
    expect(body).toContain(
      "orcaops review routine-submit --branch <b> --run <run-id> --lane account --isolation sequential --input - --json <<'EOF'"
    );
    // The acceptance responses chain the program: account input, then finalize.
    expect(body).toContain('response carries the ACCOUNT payload path');
    expect(body).toContain('never write\npayload files');
    expect(body).toContain('never invent commands');
    expect(body).toContain('the same response finalizes the run');
    // The routine two-lane program is the only generation path taught here.
    expect(body).not.toContain('narrative rehash');
  });

  it('caps are ceilings, aliases are exact, delivery is concise', () => {
    expect(body).toContain('Caps are ceilings, never targets');
    expect(body).toContain('returning zero or one finding is preferred to further');
    expect(body).toContain('never compare every hunk to optimize a ranking');
    expect(body).toContain('COPY engine-issued `c#` aliases VERBATIM');
    expect(body).toContain('Every Part needs at least one citation alias');
    expect(body).toContain('Do NOT reread or\nreproduce the rendered review');
    expect(body).toContain('quote it only if the user asks for the full text');
    expect(body).toContain('round attributed_pct only for display');
    expect(body).toContain('unattributed_rows as residue');
    expect(body).toContain('missing_boundary_checkpoints as a separate missing-boundary count');
    expect(body).toContain('never\nclaim that missing boundaries caused some or all residue');
    expect(body).toContain('ownership metrics are unavailable rather than inventing zeroes');
    expect(body).toContain(
      'Read these\nvalues from the final response, not by rereading review.md'
    );
    expect(body).toContain('unknown --profile');
  });

  it('reads each payload in a single ordered pass, not one indivisible read', () => {
    // The forensic lane reads the FULL diff in ONE sequential pass;
    // multiple Read calls over the one payload file are explicitly permitted.
    expect(body).toContain('a SINGLE ORDERED PASS over the served');
    expect(body).toContain('multiple Read calls over\nthat one file are expected');
    expect(body).toContain('no re-reads, no skipping, no second linear scan');
    expect(body).toContain('Do not write analysis scripts');
    // The indivisible "ONE direct read" framing must not return.
    expect(body).not.toContain('ONE direct read');
  });

  it('defines the forensic lane as bounded, capture-blind triage', () => {
    expect(body).toContain('BOUNDED ROUTINE REVIEW, not an exhaustive audit');
    expect(body).toContain('the FULL eligible diff');
    expect(body).toContain('capture-blind by construction');
    expect(body).toContain('at most 3 findings (each claim at most 60 words');
    expect(body).toContain('never INFO');
    expect(body).toContain('report that single input-quality finding');
    expect(body).toContain('Done is a feature');
    expect(body).toContain('never request deep-research, high-effort, or extended');
    expect(body).toContain('do not spawn subagents');
  });

  it('ranks a single-pass shortlist and teaches bounded causal file context', () => {
    expect(body).toContain('Keep a provisional shortlist while reading; do\nnot rescan');
    expect(body).toContain('Rank concrete correctness failures with an observable bad outcome');
    expect(body).toContain('then weaker verification\nor maintainability observations');
    expect(body).toContain('only with a clearly stronger issue encountered later');
    expect(body).toContain('never revisit earlier\nhunks or compare every hunk');
    expect(body).toContain('at most 4 unique exact paths from the payload');
    expect(body).toContain('each distinct from `file`');
    expect(body).toContain('engine normalizes it to `[]`');
    expect(body).toContain('"related_files": []');
  });

  it('curates a causal Story: topology + interpretation + questions, never code', () => {
    expect(body).toContain('curate exactly one cohesive causal\nStory');
    expect(body).toContain('never code ownership; the engine derives which changed rows');
    expect(body).toContain('Name and order Acts around the captured problems, decisions');
    expect(body).toContain('Chronology is provenance and an ordering tie-breaker');
    expect(body).toContain('NEVER one Act per plan');
    expect(body).toContain('NEVER one Part per checkpoint by default');
    expect(body).toContain('Preserve causal continuity without forcing one topology');
    expect(body).toContain('one Part when they are inseparable, adjacent Parts');
    expect(body).toContain('adjacent Acts only at a genuine conceptual phase boundary');
    expect(body).toContain(
      'never\n  scatter one causal move into distant, unlinked Story sections'
    );
    expect(body).toContain('Every in-scope COMPLETED checkpoint alias appears in exactly one Part');
    expect(body).toContain('Open or abandoned checkpoint aliases are context only');
    expect(body).toContain('80-word hard');
    expect(body).toContain('Word limits are ceilings, never targets');
    expect(body).toContain('retain mechanics material to');
    expect(body).toContain('never split or merge Parts merely');
    expect(body).toContain('at most 3 judgment-call questions');
    expect(body).toContain('Zero questions is the honest answer');
    expect(body).toContain('engine assigns Act/Part ids and derives membership from nesting');
    expect(body).toContain('"schema_version": 1');
    expect(body).toContain('"overview": {"text": "...", "citations": ["c3", "c18"]}');
    expect(body).toContain(
      '{"schema_version":1,"overview":{"text":"...","citations":["c3","c18"]},"acts":[...],"questions":[...]}'
    );
    expect(body).toContain('"checkpoints": ["k1", "k7"]');
    expect(body).toContain('concise title of at most 8 words');
    // The 120-code-point cap is disclosed in the routine_caps contract recap,
    // NOT in this pedagogy prose: the model can't count code points, and
    // "8 words" is the actionable lever. The validator still enforces it.
    expect(body).not.toContain('120 Unicode code points');
    expect(body).toContain('unwrap\nexactly one accidentally stringified outer JSON object');
    expect(body).toContain('never recursively unwraps');
    // ALL in-scope checkpoints across ALL threads are served to the Story pass.
    expect(body).toContain('ALL in-scope completed checkpoints across ALL floor');
    // The served payload opens with current-run facts, and the skill must tell
    // the lane to use them: a lane that can only see history will ask whether
    // a review run should happen while it is authoring one.
    expect(body).toContain('THIS RUN');
    expect(body).toContain('HISTORICAL claim');
    expect(body).toContain('untested, unrun, unresolved, or future work');
    // Scoped: this is about historical-vs-current-run contradictions only.
    expect(body).toContain('does\nNOT ask you to verify captured claims against the code');
  });

  it('requires whole-floor final-state resolution before raising an open concern', () => {
    expect(body).toContain('Final Story self-check — perform all five checks before submitting');
    expect(body).toContain('Cross-artifact causality');
    expect(body).toContain('continue,\n   validate, correct, or reverse');
    expect(body).toContain('Mixed-artifact Parts are permitted,\n   not a quota');
    expect(body).toContain('determine its\n   FINAL STATE across the ENTIRE floor');
    expect(body).toContain('not merely later checkpoints on the same thread');
    expect(body).toContain('even a different artifact thread');
    expect(body).toContain('must NOT be\n   re-raised as open');
    expect(body).toContain('criteria and criterion evidence, verified\n   close records');
    expect(body).toContain('expanded evaluator exceptions or dispositions');
    expect(body).toContain('Evaluator summary counts are capture-hygiene context');
    expect(body).toContain('A dismissed evaluator violation is historical');
    expect(body).toContain('an evaluator PASS count is not completion evidence');
    expect(body).toContain('carries its inline `[c#]` alias');
    expect(body).not.toContain('The mapping section gives every completed checkpoint');
    expect(body).toContain('Describe the final state, not a replay of\n   the journal');
    expect(body).toContain(
      'First curate the complete causal Story—including Acts, Parts, citations'
    );
    expect(body).toContain('Then write the branch-level overview from that\nfinished Story');
    expect(body).toContain('After completing the Story, write the overview from that finished');
    expect(body).toContain('read it against every Act and Part');
    expect(body).toContain('placing them only in `overview.citations`');
    expect(body).toContain('Never paste a bracketed engine-issued\nalias');
    expect(body).toContain('into `overview.text`');
  });

  it('defines positive and negative causal-grouping and reconciliation examples', () => {
    expect(body).toContain('ONE PART: one artifact chooses a cache strategy');
    expect(body).toContain('ADJACENT PARTS: an API contract is implemented');
    expect(body).toContain('ADJACENT ACTS: implementation completes');
    expect(body).toContain('KEEP SEPARATE: one artifact changes cache behavior');
    expect(body).toContain(
      'RESOLVED: an early checkpoint questions whether the fallback is exercised'
    );
    expect(body).toContain('OPEN: a checkpoint records a compatibility judgment');
  });

  it('encodes forensic-first ordering, per-lane repairs, and honest delivery', () => {
    expect(body).toContain('before you see the account');
    expect(body).toContain('refuses account context\nbefore forensic terminality');
    expect(body).toContain('TWOLANE_ROUTINE_ORDER');
    expect(body).toContain('resubmit ONCE');
    expect(body).toContain("consumes the forensic lane's independent repair credit");
    expect(body).toContain("account lane's independent repair credit");
    expect(body).toContain('degraded outcome is finalized for you');
    expect(body).toContain('Never soften a degraded outcome');
    expect(body).toContain('the file is the deliverable');
    expect(body).toContain('not part of this skill today');
  });

  it('keeps semantic anchoring explicit, complete, and independently non-adjudicating', () => {
    expect(body).toContain('only when explicitly requested');
    expect(body).toContain('Do NOT generate semantic anchors during every routine review');
    for (const state of ['READY', 'TOO_LARGE', 'NOT_ELIGIBLE', 'UNAVAILABLE'])
      expect(body, state).toContain(state);
    expect(body).toContain(
      '.orcaops/reviews/<branch-slug>/twolane/<run-id>/semantic-anchor-input-v4.md'
    );
    expect(body).toContain(
      'complete policy-eligible diff annotated with deterministic change blocks'
    );
    expect(body).toContain('per-file\ninventory of paths excluded by explicit review policy');
    expect(body).toContain('never implies that a citation refers to excluded\ncode');
    expect(body).toContain('Stop on zero or multiple matches');
    expect(body).toContain('single ordered pass, in full');
    for (const kind of [
      'PLAN_DECISION',
      'PLAN_ALTERNATIVE',
      'CHECKPOINT_DECISION',
      'CHECKPOINT_ALTERNATIVE',
      'CHECKPOINT_UNCERTAINTY',
    ])
      expect(body, kind).toContain(kind);
    expect(body).toContain('installed generation still contains every eligible item exactly once');
    expect(body).toContain('NO_ANCHOR_PROPOSED');
    expect(body).toContain('at most 8');
    expect(body).toContain('targets may cross checkpoint-owner boundaries');
    expect(body).toContain('`h#.b#` aliases');
    expect(body).toContain("block's A<n> refs");
    expect(body).toContain('`{"block":"h#.b#","scope":"WHOLE_BLOCK"}`');
    expect(body).toContain('`{"block":"h#.b#","scope":"FOCUS","focus":{...}}`');
    expect(body).toContain('An uncertainty may point broadly to the implementation or test block');
    expect(body).toContain('implemented approach alone is not proof that an alternative was');
    expect(body).toContain('Rejected alternatives, future work, absence claims, evaluation');
    expect(body).toContain('author hashes:');
    expect(body).toContain('REVIEW_MODEL_PROPOSED');
    expect(body).toContain(
      'no\ndisposition ever alters Story topology, checkpoint ownership, findings'
    );
    expect(body).toContain('no title, confidence, rationale, or extra fields');
  });

  it('teaches one semantic submission plus one optional repair, with no start verb', () => {
    expect(body).toContain(
      "orcaops review semantic-anchor-submit --run <run-id> --profile semantic-anchor-profile-v1 --input - --json <<'EOF'"
    );
    expect(body).toContain(
      'orcaops review semantic-anchor-submit --run <run-id> --generation <generation-id> --profile semantic-anchor-profile-v1 --input - --json'
    );
    expect(body).toContain('one initial submission and at most one repair');
    expect(body).toContain('FOCUS\nwhose geometry is invalid is dropped atomically');
    expect(body).not.toContain('semantic-anchor-start');
    expect(body).toContain(
      'Consumers may derive a deterministic\ndisplay title from the first sentence'
    );
    expect(body).toContain('review anchor verb remains a separate stateless helper');
  });

  it('reports the two degraded ownership states without conflating them', () => {
    expect(body).toContain('CODE_ONLY (no captured threads on the floor)');
    expect(body).toContain('there is no topology and no ownership');
    expect(body).toContain('DEGRADED_ATTRIBUTION (capture present, attribution failed)');
    expect(body).toContain('ALL code sits in unattributed\n  residue');
    expect(body).toContain('never conflate them');
  });

  it('names the primary story-review-model output and the concise artifacts', () => {
    expect(body).toContain('installed story-review-model (story-review-model-v4.json)');
    expect(body).toContain('which the reviewer reads in the TUI');
    expect(body).toContain('The concise artifacts are review.md and brief.json');
    expect(body).toContain('DERIVED, DEGRADED_ATTRIBUTION');
  });

  it('never invokes a model directly or by proxy and keeps engine state engine-owned', () => {
    expect(body).not.toContain('claude -p');
    expect(body).not.toContain('codex exec');
    expect(body).not.toContain('packages/llm');
    expect(body).not.toContain("from '@orcaops/");
    expect(body).toContain('it never calls a model, and\nyou never call one through any other CLI');
    expect(body).toContain('Never edit files under\n.orcaops/reviews/ by hand');
  });

  it('keeps the comment loop (Mode B) on the public comment surface', () => {
    expect(body).toContain('orcaops review comments --branch <b> --json');
    expect(body).toContain('orcaops review comment reply --branch <b> --id <id>');
    expect(body).toContain('--resolve');
  });

  it('does not steer task review through the retired Mode C surface', () => {
    for (const verb of [
      'orcaops review compose start',
      'orcaops review compose next',
      'orcaops review compose outline',
      'orcaops review compose contract',
      'orcaops review compose submit',
      'orcaops review compose revise',
      'orcaops review compose discard',
      'orcaops review compose finalize',
      'orcaops review check',
      'orcaops review export',
    ])
      expect(body, verb).not.toContain(verb);
    expect(body).not.toContain('# Mode C');
  });

  it('maps every named diagnostic to a repair action, and refusals to a stop', () => {
    for (const code of [
      'FORENSIC_TRANSPORT_CEILING',
      'REVIEW_DIFF_TRUNCATED',
      'TWOLANE_ROUTINE_ORDER',
      'SLICE_ROUTINE_LIMITS',
      'SLICE_PAYLOAD_SHAPE',
      'SLICE_UNKNOWN_FILE',
      'SLICE_UNKNOWN_CITATION',
      'STORY_CHECKPOINT_UNCLAIMED',
      'STORY_CHECKPOINT_DUPLICATED',
      'STORY_UNKNOWN_CHECKPOINT_REF',
      'STORY_OPEN_OR_ABANDONED_MEMBER',
      'SLICE_SUBMIT_AFTER_ACCEPT',
      'TWOLANE_ATTEMPT_BUDGET',
    ])
      expect(body, code).toContain(code);
    // The two routine-start refusals are a STOP, not a repair spend.
    expect(body).toContain('no payload was minted — NOT a repair');
  });

  it('explains what the review is (and is not)', () => {
    expect(body).toContain('ACKNOWLEDGED_BY_');
    expect(body).toContain('OUTSTANDING');
    // The merge has no conflict channel, so the prose must not promise one.
    expect(body).not.toContain('POTENTIAL_CONFLICT');
    expect(body).toContain('UNADJUDICATED');
    expect(body).toContain('attention,\nnot adjudication');
    expect(body).toContain('never a merge verdict');
  });

  it('generated host copies carry the same program (skill-copy parity)', () => {
    const repoRoot = path.join(__dirname, '..', '..', '..', '..');
    for (const copy of [
      path.join(repoRoot, '.claude', 'skills', 'orcaops-task-review', 'SKILL.md'),
      path.join(repoRoot, '.agents', 'skills', 'orcaops-task-review', 'SKILL.md'),
    ]) {
      const rendered = readFileSync(copy, 'utf8');
      expect(rendered, copy).toContain('BOUNDED ROUTINE REVIEW, not an exhaustive audit');
      expect(rendered, copy).toContain(
        "orcaops review routine-start --branch <b> [--execution-profile-json '<json>'] --json"
      );
      expect(rendered, copy).toContain('at most 3 findings (each claim at most 60 words');
      expect(rendered, copy).toContain('curate exactly one cohesive causal');
      expect(rendered, copy).toContain('carries its inline `[c#]` alias');
      expect(rendered, copy).toContain('an evaluator PASS count is not completion evidence');
      expect(rendered, copy).not.toContain('The mapping section gives every completed checkpoint');
      expect(rendered, copy).toContain('orcaops review semantic-anchor-submit --run <run-id>');
      expect(rendered, copy).not.toContain('semantic-anchor-start');
      expect(rendered, copy).not.toContain('orcaops review compose');
      expect(rendered, copy).not.toContain('orcaops review check');
      expect(rendered, copy).not.toContain('orcaops review export');
    }
  });
});
