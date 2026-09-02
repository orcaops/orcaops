/**
 * The classification of every method on the SDK's `OrcaCloudClient`: which
 * carry author-written text, and where each is gated.
 *
 * Single-sourced here because two tests read it and must stay in lockstep —
 * `cloud-write-surface.test.ts` proves the inventory covers the SDK surface,
 * and `cloud-secret-gate-refusal.test.ts` proves every verb the inventory
 * calls gated actually refuses a credential at runtime.
 */

export type Disposition =
  /** Read-only, or sends no author-written text. */
  | 'no-authored-content'
  /** Sends author-written text and MUST call the outbound gate. */
  | { gatedIn: string }
  /** Sends author-written text that was already gated at the capture boundary. */
  | 'gated-upstream'
  /**
   * Sends a field that is not author-written yet can still carry a credential,
   * so no gate applies to it — it is sanitized where it is read instead. Names
   * the file holding the sanitizer, so removing it fails this test.
   */
  | { sanitizedIn: string }
  /**
   * Sends author-written text and is KNOWN to be ungated. Asserted as an
   * exact set below, so a gap is declared rather than omitted — the failure
   * mode this whole file exists to prevent is a verb quietly missing from an
   * inventory.
   */
  | 'gate-pending';

export const DISPOSITIONS: Record<string, Record<string, Disposition>> = {
  cli: { ping: 'no-authored-content' },
  user: { me: 'no-authored-content' },
  repo: { upsertByRemote: 'no-authored-content' },
  captureThread: {
    // Author-written content reaches this from two directions, each gated at
    // its own input boundary: capture payloads by `runCaptureWithSync`, and
    // synthesized git history by `redactSeedNarrative` before `orcaops seed`
    // writes it to the store. But `start` also ships `repoUrl`, which is not
    // authored and which neither gate sees, so it is classified by the
    // sanitizer that does cover it.
    start: { sanitizedIn: '../../packages/core/src/git/remote-url.ts' },
    update: 'gated-upstream',
    complete: 'no-authored-content',
    attachPlan: 'gated-upstream',
    attachPlanRevision: 'gated-upstream',
    attachCheckpointOpened: 'gated-upstream',
    attachCheckpoint: 'gated-upstream',
    attachSummary: 'gated-upstream',
    // Evaluator output is scrubbed at write by the evaluator runner before it
    // is ever persisted, so what reaches the wire is already redacted.
    attachEvaluators: 'gated-upstream',
    attachCodingSessionsUsage: 'no-authored-content',
  },
  sourcePlan: {
    // A born-pin mints its hash locally from a user-supplied file, so it is
    // ours to refuse.
    attachPin: { gatedIn: 'src/lib/source-plan-resolver.ts' },
    create: { gatedIn: 'src/commands/plan/upload.ts' },
    reviewPush: { gatedIn: 'src/commands/plan/review/push.ts' },
    reviewPropose: { gatedIn: 'src/commands/plan/review/propose.ts' },
    reviewComment: { gatedIn: 'src/commands/plan/review/comment.ts' },
    setReviewerVerdict: { gatedIn: 'src/commands/plan/review/verdict.ts' },
    declineProposal: { gatedIn: 'src/commands/plan/review/decline.ts' },
    getApproved: 'no-authored-content',
    get: 'no-authored-content',
    reviewPull: 'no-authored-content',
    list: 'no-authored-content',
    reviewDetail: 'no-authored-content',
    listReviewers: 'no-authored-content',
  },
  review: {
    reply: { gatedIn: 'src/commands/review/reply.ts' },
    status: 'no-authored-content',
    pull: 'no-authored-content',
    resolve: 'no-authored-content',
  },
};

/** `namespace.method` for every verb the inventory says the gate must cover. */
export function gatedVerbs(): string[] {
  const gated: string[] = [];
  for (const [namespace, methods] of Object.entries(DISPOSITIONS)) {
    for (const [method, disposition] of Object.entries(methods)) {
      if (typeof disposition === 'object' && 'gatedIn' in disposition) {
        gated.push(`${namespace}.${method}`);
      }
    }
  }
  return gated.sort();
}
