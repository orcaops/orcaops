import type { expandProjectRationaleContext } from '@orcaops/storage/history/database';

type QualifiedAccount = Extract<
  ReturnType<typeof expandProjectRationaleContext>['value'],
  { status: 'available' }
>;

export function currentAccountStatus(account: QualifiedAccount) {
  return account.qualifications.map((entry) => {
    const resolved = entry.content?.resolved;
    return {
      target: entry.target,
      available: !!resolved,
      revisions: resolved?.revisions.map((revision) => ({
        id: revision.revision.revision_id,
        scope: revision.scope,
        standing: revision.standing,
        designation: revision.designation,
        applicability: revision.applicability,
      })),
      ...(resolved?.conflicts.length ? { conflicts: resolved.conflicts } : {}),
      ...(resolved?.proposals.length ? { proposals: resolved.proposals } : {}),
      ...(resolved?.exceptions.length ? { exceptions: resolved.exceptions } : {}),
      ...(resolved?.recorded_choices.length ? { recorded_choices: resolved.recorded_choices } : {}),
      ...(resolved?.branch_scoped.length ? { branch_scoped: resolved.branch_scoped } : {}),
      ...(resolved?.assignments ? { assignments: resolved.assignments } : {}),
      ...(resolved?.relationships.length ? { relationships: resolved.relationships } : {}),
      ...(resolved?.correction_effects.length
        ? { correction_effects: resolved.correction_effects }
        : {}),
      ...(entry.corrections.length
        ? {
            corrections: entry.corrections.map((correction) =>
              account.reference === `correction:${correction.action_id}`
                ? {
                    action_id: correction.action_id,
                    status: correction.status,
                    action_from: 'content',
                  }
                : correction
            ),
          }
        : {}),
      ...(resolved?.unresolved.length ? { unresolved: resolved.unresolved } : {}),
      ...(resolved?.omissions.length ? { omissions: resolved.omissions } : {}),
    };
  });
}
