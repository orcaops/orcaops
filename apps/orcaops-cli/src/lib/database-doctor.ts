import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import { Repo } from '@orcaops/core';
import {
  type DatabaseMaintenanceInspection,
  type DatabaseMaintenanceResource,
  inspectDatabaseMaintenance,
  type RegisteredDatabaseContext,
} from '@orcaops/core/history/database-retention';
import type { Pin, ShellKey } from '@orcaops/storage';
import {
  hasProjectSessionBranchState,
  type ProjectDatabase,
  ProjectDatabaseError,
  readProjectApprovedSourcePlan,
  readProjectArtifact,
  readProjectCloudSyncState,
  readProjectExecution,
  readProjectExecutionFocus,
  readProjectPendingCapture,
  readProjectSeedClusters,
  readProjectSeedJobs,
  readProjectSeedState,
  readProjectSourcePlanHistoricalDisclosure,
  readProjectSourcePlanLocator,
  readProjectSourcePlanReview,
  readProjectStatistics,
  readProjectUsageAccounting,
} from '@orcaops/storage/history/database';
import { historyMetadataDetails } from '@orcaops/storage/history/metadata-row';

import type { DoctorCheck, DoctorStatus } from '../commands/doctor.js';

const STALE_HOURS = 24;
const PIN_AGE_DAYS_WARN = 7;
const DISMISS_RATE_MIN_RUNS = 3;
const DISMISS_RATE_WARN = 0.5;

export interface DatabaseDoctorInput {
  database: ProjectDatabase;
  context: RegisteredDatabaseContext;
  pins: readonly Pin[];
  shellKey: ShellKey;
  historyCommitCount: number;
  dispositionTtlDays: number;
  now?: number;
}

export interface DatabaseDoctorResult {
  checks: DoctorCheck[];
  seedNeedsRepair: boolean;
}

function truncate(value: string, length: number): string {
  return value.length <= length ? value : `${value.slice(0, length - 1)}…`;
}

function artifactActivity(
  details: ReturnType<typeof readProjectStatistics>['artifacts'][number]['details']
): number {
  return Math.max(
    Date.parse(details.activity.startedAt),
    details.activity.summaryAt === null ? 0 : Date.parse(details.activity.summaryAt),
    ...details.activity.checkpoints.map(({ openedAt, endedAt }) => Date.parse(endedAt ?? openedAt))
  );
}

function staleArtifacts(
  statistics: ReturnType<typeof readProjectStatistics>,
  now: number
): DoctorCheck {
  const active = statistics.artifacts.filter(({ row }) => row.completedAt === null);
  const cutoff = now - STALE_HOURS * 60 * 60 * 1000;
  const stale = active.filter(({ details }) => artifactActivity(details) < cutoff);
  if (!stale.length)
    return {
      name: 'stale-artifacts',
      status: 'pass',
      summary: `${active.length} active artifact(s); none idle >${STALE_HOURS}h`,
    };
  return {
    name: 'stale-artifacts',
    status: 'warn',
    summary: `${stale.length} active artifact(s) idle >${STALE_HOURS}h`,
    details: stale.map(({ row, details }) => {
      const age = Math.round((now - artifactActivity(details)) / 3_600_000);
      return `  - ${row.artifactId} (${row.branch}): ${age}h — "${truncate(details.task, 60)}"`;
    }),
  };
}

function staleOpenCheckpoints(
  statistics: ReturnType<typeof readProjectStatistics>,
  now: number
): DoctorCheck {
  const open = statistics.artifacts.flatMap(({ row, details }) =>
    details.openCheckpoints.map((checkpoint) => ({ artifactId: row.artifactId, checkpoint }))
  );
  const cutoff = now - STALE_HOURS * 60 * 60 * 1000;
  const stale = open.filter(({ checkpoint }) => Date.parse(checkpoint.opened_at) < cutoff);
  if (!stale.length)
    return {
      name: 'open-checkpoint-stale',
      status: 'pass',
      summary: open.length
        ? `${open.length} open checkpoint(s); none idle >${STALE_HOURS}h`
        : 'no open checkpoints',
    };
  return {
    name: 'open-checkpoint-stale',
    status: 'warn',
    summary: `${stale.length} open checkpoint(s) idle >${STALE_HOURS}h`,
    details: stale.map(({ artifactId, checkpoint }) => {
      const age = Math.round((now - Date.parse(checkpoint.opened_at)) / 3_600_000);
      return `  - ${artifactId} cp #${checkpoint.n}: idle ${age}h`;
    }),
  };
}

interface ArtifactEvaluatorRuns {
  readonly artifactId: string;
  readonly runs: ReturnType<typeof historyMetadataDetails>['evaluatorRuns'];
}

function unresolvedBlocks(artifacts: readonly ArtifactEvaluatorRuns[]): DoctorCheck {
  const unresolved = artifacts.flatMap(({ artifactId, runs }) =>
    runs
      .filter(
        (run) =>
          run.severity === 'block' &&
          run.verdict === 'violation' &&
          (run.disposition === null || run.disposition === 'unresolved')
      )
      .map((run) => ({ artifactId, ...run }))
  );
  return unresolved.length
    ? {
        name: 'unresolved-blocks',
        status: 'warn',
        summary: `${unresolved.length} unresolved block-severity evaluator violation(s)`,
        details: unresolved.map(
          (run) => `  - ${run.artifactId}: ${run.evaluator_ref} (${run.run_id})`
        ),
      }
    : {
        name: 'unresolved-blocks',
        status: 'pass',
        summary: 'no unresolved block-severity evaluator violations',
      };
}

type RetainedArtifact = NonNullable<ReturnType<typeof readProjectArtifact>>;

function evaluatorHistory(
  snapshots: readonly RetainedArtifact[],
  statistics: ReturnType<typeof readProjectStatistics>,
  exactRuns: readonly ArtifactEvaluatorRuns[],
  dispositionTtlDays: number,
  now: number
): DoctorCheck[] {
  const logs = snapshots.flatMap(({ thread }) =>
    thread.evaluatorLog === null ? [] : [thread.evaluatorLog]
  );
  const runs = logs
    .flatMap((log) => log.runs)
    .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts) || a.run_id.localeCompare(b.run_id));
  const dispositions = logs.flatMap((log) => log.dispositions);
  const byEvaluator = new Map<string, typeof runs>();
  for (const run of runs)
    byEvaluator.set(run.evaluator_ref, [...(byEvaluator.get(run.evaluator_ref) ?? []), run]);
  const resolutions = new Map<string, { resolved: number; dismissed: number }>();
  for (const run of runs) {
    if (run.run_status !== 'completed' || run.verdict !== 'pass') continue;
    const value = resolutions.get(run.evaluator_ref) ?? { resolved: 0, dismissed: 0 };
    value.resolved++;
    resolutions.set(run.evaluator_ref, value);
  }
  for (const disposition of dispositions) {
    const value = resolutions.get(disposition.evaluator_ref) ?? { resolved: 0, dismissed: 0 };
    value.resolved++;
    if (['dismissed', 'policy-excepted'].includes(disposition.disposition)) value.dismissed++;
    resolutions.set(disposition.evaluator_ref, value);
  }
  const eligibleResolutions = [...resolutions].filter(
    ([, value]) => value.resolved >= DISMISS_RATE_MIN_RUNS
  );
  const dismissed = eligibleResolutions.filter(
    ([, value]) => value.dismissed / value.resolved >= DISMISS_RATE_WARN
  );
  const persistentlyErrored = [...byEvaluator].filter(([, rows]) => {
    const terminal = rows.slice(-3);
    return terminal.length === 3 && terminal.every((run) => run.run_status === 'error');
  });
  const skipped = [...byEvaluator].filter(([, rows]) => {
    const count = rows.filter((run) => run.run_status === 'skipped').length;
    return rows.length >= 5 && count / rows.length >= 0.7;
  });
  const materializedByArtifact = new Map(
    statistics.artifacts.map(({ row, details }) => [row.artifactId, details.evaluatorRuns])
  );
  const inconsistent = exactRuns.filter(
    ({ artifactId, runs }) => !isDeepStrictEqual(materializedByArtifact.get(artifactId), runs)
  );
  return [
    dismissed.length
      ? {
          name: 'evaluator-dismiss-rate',
          status: 'warn',
          summary: `${dismissed.length} evaluator(s) have high dismissal rates`,
          details: dismissed.map(([name, value]) => {
            return `  - ${name}: ${value.dismissed}/${value.resolved} resolutions dismissed`;
          }),
        }
      : {
          name: 'evaluator-dismiss-rate',
          status: 'pass',
          summary:
            eligibleResolutions.length === 0
              ? `no evaluator has ≥${DISMISS_RATE_MIN_RUNS} retained resolutions`
              : 'no evaluator has a high dismissal rate with enough retained resolutions',
        },
    persistentlyErrored.length
      ? {
          name: 'persistent-evaluator-errors',
          status: 'warn',
          summary: `${persistentlyErrored.length} evaluator(s) have three trailing errors`,
          details: persistentlyErrored.map(([name]) => `  - ${name}`),
        }
      : {
          name: 'persistent-evaluator-errors',
          status: 'pass',
          summary: 'no evaluator has three consecutive errors in its trailing retained runs',
        },
    skipped.length
      ? {
          name: 'skipped-run-analytics',
          status: 'warn',
          summary: `${skipped.length} evaluator(s) have high skip rates`,
          details: skipped.map(([name, rows]) => {
            const count = rows.filter((run) => run.run_status === 'skipped').length;
            return `  - ${name}: ${count}/${rows.length} skipped`;
          }),
        }
      : {
          name: 'skipped-run-analytics',
          status: 'pass',
          summary: 'no evaluator has a skip rate ≥70% with at least five retained runs',
        },
    {
      name: 'stale-dispositions',
      status: dispositions.some(
        (disposition) => Date.parse(disposition.ts) < now - dispositionTtlDays * 86_400_000
      )
        ? 'warn'
        : 'pass',
      summary: (() => {
        const count = dispositions.filter(
          (disposition) => Date.parse(disposition.ts) < now - dispositionTtlDays * 86_400_000
        ).length;
        return count
          ? `${count} disposition(s) older than ${dispositionTtlDays} days`
          : `no disposition older than ${dispositionTtlDays} days`;
      })(),
      details: (() => {
        const rows = dispositions.filter(
          (disposition) => Date.parse(disposition.ts) < now - dispositionTtlDays * 86_400_000
        );
        return rows.length
          ? rows
              .slice(0, 10)
              .map((row) => `  - ${row.evaluator_ref} [${row.disposition}] from ${row.ts}`)
          : undefined;
      })(),
    },
    inconsistent.length
      ? {
          name: 'materialized-disposition-consistency',
          status: 'fail',
          summary: `${inconsistent.length} artifact(s) have evaluator materialization that differs from exact retained history`,
          details: inconsistent.map(
            ({ artifactId }) => `  - ${artifactId}: evaluator run materialization differs`
          ),
        }
      : {
          name: 'materialized-disposition-consistency',
          status: 'pass',
          summary: `${dispositions.length} disposition event(s) match exact retained evaluator materialization`,
        },
  ];
}

function pinChecks(
  pins: readonly Pin[],
  statistics: ReturnType<typeof readProjectStatistics>,
  executions: Map<string, NonNullable<ReturnType<typeof readProjectExecution>>>,
  now: number
): DoctorCheck[] {
  const artifacts = new Map(
    statistics.artifacts.map((artifact) => [artifact.row.artifactId, artifact])
  );
  const stale = pins.flatMap((pin) => {
    const artifact = artifacts.get(pin.artifact_id);
    if (!artifact) return [{ pin, reason: 'artifact missing from registered database' }];
    if (artifact.row.completedAt !== null) return [{ pin, reason: 'artifact is complete' }];
    const execution = executions.get(pin.artifact_id);
    if (!execution) return [{ pin, reason: 'execution history is unavailable' }];
    if (execution.state.current_binding?.git_context.branch !== pin.branch)
      return [{ pin, reason: 'binding branch differs from the pin' }];
    return [];
  });
  const cutoff = now - PIN_AGE_DAYS_WARN * 86_400_000;
  const aged = pins.filter((pin) => {
    const artifact = artifacts.get(pin.artifact_id);
    return artifact?.row.completedAt === null && Date.parse(pin.pinned_at) < cutoff;
  });
  const pinned = new Set(pins.map((pin) => pin.artifact_id));
  const active = statistics.artifacts.filter(({ row }) => row.completedAt === null);
  const orphans = active.filter(({ row }) => !pinned.has(row.artifactId));
  return [
    stale.length
      ? {
          name: 'stale-pin',
          status: 'warn',
          summary: `${stale.length} of ${pins.length} pin(s) have stale database targets`,
          details: stale.map(({ pin, reason }) => `  - ${pin.artifact_id}: ${reason}`),
        }
      : {
          name: 'stale-pin',
          status: 'pass',
          summary: pins.length
            ? `${pins.length} pin(s); all database targets are current`
            : 'no pins to check',
        },
    aged.length
      ? {
          name: 'aged-pin',
          status: 'warn',
          summary: `${aged.length} pin(s) older than ${PIN_AGE_DAYS_WARN}d on active artifacts`,
          details: aged.map((pin) => `  - ${pin.artifact_id}: pinned ${pin.pinned_at}`),
        }
      : {
          name: 'aged-pin',
          status: 'pass',
          summary: `no pins older than ${PIN_AGE_DAYS_WARN}d on active artifacts`,
        },
    {
      name: 'pin-orphan',
      status: 'pass',
      summary: `${orphans.length} of ${active.length} active artifact(s) have no ephemeral pin`,
      ...(orphans.length
        ? { details: orphans.map(({ row }) => `  - ${row.artifactId} (${row.branch})`) }
        : {}),
    },
  ];
}

function retainedPinChecks(
  snapshots: readonly RetainedArtifact[],
  statistics: ReturnType<typeof readProjectStatistics>
): DoctorCheck[] {
  const activeIds = new Set(
    statistics.artifacts
      .filter(({ row }) => row.completedAt === null)
      .map(({ row }) => row.artifactId)
  );
  const active = snapshots.filter(({ artifactId }) => activeIds.has(artifactId));
  const displaced = active.flatMap((snapshot) => {
    const events = snapshot.thread.events.filter(({ record }) => record.type === 'pin_displaced');
    return events.length
      ? [
          {
            artifactId: snapshot.artifactId,
            count: events.length,
            last: events.at(-1)!.record.ts,
          },
        ]
      : [];
  });
  const sessionGroups = new Map<string, RetainedArtifact[]>();
  for (const snapshot of active) {
    const metadata = snapshot.thread.artifactJson!;
    if (!metadata.created_by_session_id) continue;
    const key = `${metadata.branch_lineage.at(-1)!.branch}\0${metadata.created_by_session_id}`;
    sessionGroups.set(key, [...(sessionGroups.get(key) ?? []), snapshot]);
  }
  const repeated = [...sessionGroups.values()].filter((group) => group.length > 1);
  return [
    displaced.length
      ? {
          name: 'pin-displaced',
          status: 'warn',
          summary: `${displaced.length} active artifact(s) retain displaced-pin evidence`,
          details: displaced.map(
            (entry) => `  - ${entry.artifactId}: ${entry.count} event(s); last at ${entry.last}`
          ),
        }
      : {
          name: 'pin-displaced',
          status: 'pass',
          summary: `${active.length} active artifact(s); none retain displaced-pin evidence`,
        },
    {
      name: 'same-session-multi-active',
      status: 'pass',
      summary: `${repeated.length} branch and authoring-session group(s) have multiple active artifacts`,
      ...(repeated.length
        ? {
            details: repeated.flatMap((group) => {
              const metadata = group[0]!.thread.artifactJson!;
              return [
                `  - branch=${metadata.branch_lineage.at(-1)!.branch} session=${metadata.created_by_session_id!.slice(0, 12)}…`,
                ...group.map((snapshot) => `      ${snapshot.artifactId}`),
              ];
            }),
          }
        : {}),
    },
  ];
}

function seedCheck(
  database: ProjectDatabase,
  statistics: ReturnType<typeof readProjectStatistics>,
  historyCommitCount: number
): { check: DoctorCheck; needsRepair: boolean } {
  const state = readProjectSeedState(database);
  if (!state) {
    const needsRepair = historyCommitCount > 0;
    return {
      needsRepair,
      check: needsRepair
        ? {
            name: 'seed',
            status: 'warn',
            summary: 'Git history exists but the project database has no seed state',
            details: ['Preview with `orcaops seed --dry-run`; apply with `orcaops seed --yes`.'],
          }
        : { name: 'seed', status: 'pass', summary: 'no Git history to seed' },
    };
  }
  const clusters = readProjectSeedClusters(database, { revision: state.revision });
  const jobs = readProjectSeedJobs(database, { revision: state.revision });
  const entries = Object.values(clusters?.clusters ?? {});
  const pending =
    state.precious?.pending_importance === true ||
    entries.some((cluster) => ['pending', 'writing', 'failed'].includes(cluster.status));
  const imported = statistics.counts.imported;
  const live = statistics.counts.captured;
  return {
    needsRepair: pending,
    check: pending
      ? {
          name: 'seed',
          status: 'warn',
          summary: `database seed state is partial (${imported} imported artifact(s))`,
          details: ['Resume with `orcaops seed --yes` or run `orcaops doctor --fix`.'],
        }
      : {
          name: 'seed',
          status: state.completeness.complete ? 'pass' : 'warn',
          summary: `${live} live and ${imported} imported artifact(s); ${entries.length} seed cluster(s), ${Object.keys(jobs?.jobs ?? {}).length} seed job(s)`,
          ...(state.completeness.complete ? {} : { details: [...state.completeness.issues] }),
        },
  };
}

function sourcePlanChecks(
  database: ProjectDatabase,
  snapshots: readonly RetainedArtifact[]
): DoctorCheck[] {
  const pins = snapshots.flatMap(({ artifactId, thread }) =>
    thread.artifactJson?.source_plan ? [{ artifactId, pin: thread.artifactJson.source_plan }] : []
  );
  const driftedPins = pins.filter(
    ({ pin }) => createHash('sha256').update(pin.content).digest('hex') !== pin.hash
  );
  const keys = database.read((view) => ({
    approved: view.all<{
      namespaceId: string;
      externalId: string;
      approvedVersion: number;
    }>(
      `SELECT namespaceId,externalId,approvedVersion FROM (
        SELECT namespace_id AS namespaceId,external_id AS externalId,approved_version AS approvedVersion FROM source_plan_approved
        UNION
        SELECT namespace_id,external_id,approved_version FROM source_plan_records WHERE kind='approved'
        UNION
        SELECT json_extract(target_json,'$.namespaceId'),json_extract(target_json,'$.externalId'),json_extract(target_json,'$.approvedVersion')
        FROM operations WHERE operation_kind='source_plan.record' AND json_extract(target_json,'$.kind')='approved'
      ) ORDER BY namespaceId,externalId,approvedVersion`
    ),
    reviews: view.all<{ namespaceId: string; kind: 'candidate' | 'proposal'; subjectId: string }>(
      `SELECT namespaceId,kind,subjectId FROM (
        SELECT namespace_id AS namespaceId,kind,subject_id AS subjectId FROM source_plan_review_current
        UNION
        SELECT namespace_id,kind,CASE kind WHEN 'candidate' THEN external_id ELSE proposal_id END
        FROM source_plan_records WHERE kind IN ('candidate','proposal')
        UNION
        SELECT json_extract(target_json,'$.namespaceId'),json_extract(target_json,'$.kind'),json_extract(target_json,'$.subjectId')
        FROM operations WHERE operation_kind='source_plan.record' AND json_extract(target_json,'$.kind') IN ('candidate','proposal')
      ) ORDER BY namespaceId,kind,subjectId`
    ),
    locators: view.all<{ namespaceId: string; kind: 'path' | 'upload'; realPath: string }>(
      `SELECT namespaceId,kind,realPath FROM (
        SELECT namespace_id AS namespaceId,kind,locator AS realPath FROM source_plan_locator_current WHERE locator_kind='real_path'
        UNION
        SELECT namespace_id,kind,real_path FROM source_plan_locator_revisions
        UNION
        SELECT json_extract(target_json,'$.namespaceId'),json_extract(target_json,'$.kind'),json_extract(target_json,'$.realPath')
        FROM operations WHERE operation_kind='source_plan.locator'
      ) ORDER BY namespaceId,kind,realPath`
    ),
  })).value;
  for (const key of keys.approved)
    if (!readProjectApprovedSourcePlan(database, key))
      throw new ProjectDatabaseError(
        'HISTORY_INTEGRITY_REQUIRED',
        `Selected Source Plan approval ${key.externalId} is missing; preserve history for explicit repair`
      );
  for (const key of keys.reviews)
    if (!readProjectSourcePlanReview(database, key))
      throw new ProjectDatabaseError(
        'HISTORY_INTEGRITY_REQUIRED',
        `Selected Source Plan ${key.kind} ${key.subjectId} is missing; preserve history for explicit repair`
      );
  for (const key of keys.locators)
    if (!readProjectSourcePlanLocator(database, key))
      throw new ProjectDatabaseError(
        'HISTORY_INTEGRITY_REQUIRED',
        `Selected Source Plan ${key.kind} locator ${key.realPath} is missing; preserve history for explicit repair`
      );
  const historical = readProjectSourcePlanHistoricalDisclosure(database);
  return [
    driftedPins.length
      ? {
          name: 'source-plan-pin-integrity',
          status: 'warn',
          summary: `${driftedPins.length} of ${pins.length} pinned Source Plans differ from their retained content hash`,
          details: [
            ...driftedPins.map(({ artifactId }) => `  - ${artifactId}`),
            'Preserve the artifact and explicitly re-pin the approved Source Plan before publishing.',
          ],
        }
      : {
          name: 'source-plan-pin-integrity',
          status: 'pass',
          summary: pins.length
            ? `${pins.length} pinned Source Plan(s); all content hashes match`
            : 'no pinned Source Plans',
        },
    {
      name: 'source-plan-history',
      status: historical.count ? 'warn' : 'pass',
      summary:
        `${keys.approved.length} approval(s), ${keys.reviews.length} review selection(s), ` +
        `${keys.locators.length} locator(s); ${historical.count} retained record(s) with unknown historical account`,
      ...(historical.count
        ? {
            details: [
              ...historical.locations.map((location) => `  - ${location}`),
              'Preserve these records; their account namespace cannot be inferred during diagnosis.',
            ],
          }
        : {}),
    },
  ];
}

function skippedFingerprintCheck(snapshots: readonly RetainedArtifact[]): DoctorCheck {
  const checkpoints = snapshots
    .flatMap(({ thread }) =>
      thread.checkpoints.flatMap((checkpoint) =>
        checkpoint.status === 'closed' ? [checkpoint] : []
      )
    )
    .sort((a, b) => Date.parse(b.closed_at) - Date.parse(a.closed_at))
    .slice(0, 20);
  const skipped = checkpoints.filter(
    (checkpoint) => checkpoint.diff_fingerprint_summary.status === 'skipped'
  );
  const rate = checkpoints.length ? skipped.length / checkpoints.length : 0;
  return rate > 0.2
    ? {
        name: 'skipped-fingerprint-rate',
        status: 'warn',
        summary: `${skipped.length}/${checkpoints.length} recent closed checkpoints skipped fingerprint capture`,
        details: skipped.map(
          (checkpoint) =>
            `  - ${checkpoint.artifact_id} cp #${checkpoint.n}: ${checkpoint.diff_fingerprint_summary.error_reason ?? 'deliberately skipped'}`
        ),
      }
    : {
        name: 'skipped-fingerprint-rate',
        status: 'pass',
        summary: checkpoints.length
          ? `${skipped.length}/${checkpoints.length} recent closed checkpoints skipped fingerprint capture`
          : 'no closed checkpoints to inspect',
      };
}

async function lineageCheck(
  context: RegisteredDatabaseContext,
  snapshots: readonly RetainedArtifact[]
): Promise<DoctorCheck> {
  const repo = new Repo(context.git.worktreeRoot);
  const tips = await repo.listLocalBranchTipsState();
  if (tips.status === 'unknown')
    return {
      name: 'lineage-orphan',
      status: 'warn',
      summary: 'could not enumerate local branch tips',
    };
  if (!tips.tips.length && snapshots.length)
    return {
      name: 'lineage-orphan',
      status: 'warn',
      summary: `${snapshots.length} artifact(s); no local branches are available to verify retained lineage`,
      details: [
        'Preserve the artifacts and restore or inspect their original Git evidence before recording new lineage.',
      ],
    };
  if (!tips.tips.length)
    return {
      name: 'lineage-orphan',
      status: 'pass',
      summary: 'no retained lineage or local branches to compare',
    };
  const rows = snapshots.map(({ artifactId, thread }) => ({
    artifactId,
    lineage: thread.artifactJson!.branch_lineage.at(-1)!,
  }));
  const orphaned: typeof rows = [];
  const uncertain: typeof rows = [];
  const reachability = await repo.checkReachabilityFromTips(
    rows.map((row) => row.lineage.head_sha),
    tips.tips
  );
  for (const row of rows) {
    const state = reachability.get(row.lineage.head_sha);
    if (state === 'reachable') continue;
    if (state === 'unreachable') orphaned.push(row);
    else uncertain.push(row);
  }
  if (!orphaned.length && !uncertain.length)
    return {
      name: 'lineage-orphan',
      status: 'pass',
      summary: `${rows.length} artifact(s); all latest lineage SHAs reach a local branch`,
    };
  return {
    name: 'lineage-orphan',
    status: 'warn',
    summary: `${orphaned.length} unreachable and ${uncertain.length} uncertain latest lineage SHA(s)`,
    details: [
      ...orphaned.map(
        ({ artifactId, lineage }) =>
          `  - ${artifactId} (last on ${lineage.branch} @ ${lineage.head_sha.slice(0, 8)}): unreachable`
      ),
      ...uncertain.map(
        ({ artifactId, lineage }) =>
          `  - ${artifactId} (last on ${lineage.branch} @ ${lineage.head_sha.slice(0, 8)}): reachability unknown`
      ),
      'Preserve the artifact and inspect its original Git evidence before recording new lineage.',
    ],
  };
}

function pendingPlanCheck(database: ProjectDatabase): DoctorCheck {
  const pending = database.read((view) =>
    view.all<{ operationId: string }>(
      'SELECT DISTINCT original_operation_id AS operationId FROM pending_plan_keys ORDER BY original_operation_id'
    )
  ).value;
  for (const { operationId } of pending) {
    if (!readProjectPendingCapture(database, operationId).value)
      throw new ProjectDatabaseError(
        'HISTORY_INTEGRITY_REQUIRED',
        `Pending plan operation ${operationId} has no retained capture input; preserve history for explicit repair`
      );
  }
  return pending.length
    ? {
        name: 'plan-idempotency',
        status: 'warn',
        summary: `${pending.length} plan capture operation(s) retain unsettled idempotency ownership`,
        details: pending.map(({ operationId }) => `  - ${operationId}`),
      }
    : {
        name: 'plan-idempotency',
        status: 'pass',
        summary: 'no unsettled plan capture ownership',
      };
}

function cloudSyncCheck(database: ProjectDatabase): DoctorCheck {
  const keys = database.read((view) =>
    view.all<{ artifactId: string; server: string; org: string; account: string }>(
      `SELECT DISTINCT artifact_id AS artifactId, server_url AS server, org_id AS org,
        account_id AS account FROM cloud_sync_records ORDER BY artifact_id, server_url, org_id, account_id`
    )
  ).value;
  const pending = keys.flatMap((key) => {
    const state = readProjectCloudSyncState(database, key.artifactId, {
      server_url: key.server,
      org_id: key.org,
      account_id: key.account,
    });
    return state?.pending ? [{ key, state }] : [];
  });
  return pending.length
    ? {
        name: 'cloud-sync-pending',
        status: 'warn',
        summary: `${pending.length} retained artifact target(s) are pending cloud sync`,
        details: pending.map(({ key, state }) => {
          const reason = state.lastError
            ? `${state.lastError.kind}: ${state.lastError.message ?? 'no detail'}`
            : 'no retained acknowledgement for current history';
          const action =
            state.lastError?.kind === 'upgrade-required'
              ? 'upgrade your orcaops install, then run `orcaops resync`'
              : state.lastError?.kind === 'content-invalid'
                ? 'preserve the retained artifact and report this diagnostic; do not force a resend'
                : 'inspect the original operation, then run `orcaops resync --force` only when retry is safe';
          return `  - ${key.artifactId} @ ${key.server}/${key.org}/${key.account}: ${reason}; ${action}`;
        }),
      }
    : {
        name: 'cloud-sync-pending',
        status: 'pass',
        summary: `${keys.length} retained cloud target(s); none pending`,
      };
}

function publicationDetail(resource: DatabaseMaintenanceResource): string {
  const identity = [
    `publication=${resource.publicationId ?? 'unowned'}`,
    `original-operation=${resource.originalOperationId ?? 'none'}`,
    `admission=${resource.admissionOperationId ?? 'none'}`,
    `expected-oid=${resource.expectedOid ?? 'none'}`,
    `observed-oid=${resource.observedOid ?? 'none'}`,
  ];
  if (resource.symbolicTarget) identity.push(`symbolic-target=${resource.symbolicTarget}`);
  if (resource.target)
    identity.push(
      `reclamation-target=${resource.target.publicationId}`,
      `retired-transition=${resource.target.retiredTransitionId}`
    );
  return `  - ${resource.fullRef}: ${resource.state}/${resource.reason}; ${identity.join('; ')}`;
}

export function databaseMaintenanceCheck(inspection: DatabaseMaintenanceInspection): DoctorCheck {
  const unsafe = inspection.resources.filter((resource) =>
    ['malformed', 'conflicting', 'dangling', 'inaccessible'].includes(resource.reason)
  );
  const advisory = inspection.resources.filter(
    (resource) =>
      resource.state === 'eligible' || ['unknown', 'pending', 'symbolic'].includes(resource.reason)
  );
  const states = {
    eligible: inspection.resources.filter((resource) => resource.state === 'eligible').length,
    protected: inspection.resources.filter((resource) => resource.state === 'protected').length,
    reclaimed: inspection.resources.filter((resource) => resource.state === 'reclaimed').length,
  };
  const pending = inspection.pendingAdmissions.length;
  const status: DoctorStatus =
    !inspection.completeness.complete || unsafe.length
      ? 'fail'
      : advisory.length || pending
        ? 'warn'
        : 'pass';
  const details = [
    ...inspection.completeness.issues.map(
      (issue) => `  - ${issue.resourceId ?? 'namespace'}: ${issue.code} — ${issue.message}`
    ),
    ...inspection.resources.map(publicationDetail),
    ...inspection.pendingAdmissions.map(
      (admission) =>
        `  - pending admission ${admission.admissionOperationId}: terminal=${admission.terminalOperationId}; ` +
        `publication=${admission.target.publicationId}; original-operation=${admission.target.originalOperationId}; ` +
        `ref=${admission.target.fullRef}; oid=${admission.target.objectOid}; ` +
        `retired-transition=${admission.target.retiredTransitionId}`
    ),
  ];
  if (status !== 'pass')
    details.push(
      'Preserve every affected ref; use explicit maintenance only after inspecting its retained identity and reason.'
    );
  return {
    name: 'git-publications',
    status,
    summary:
      `${inspection.resources.length} publication ref(s): ${states.eligible} eligible, ` +
      `${states.protected} protected, ${states.reclaimed} reclaimed; ` +
      `${pending} pending reclamation admission(s)`,
    ...(details.length ? { details } : {}),
  };
}

async function publicationCheck(
  database: ProjectDatabase,
  context: RegisteredDatabaseContext
): Promise<DoctorCheck> {
  const inspection = await inspectDatabaseMaintenance(database, context);
  return databaseMaintenanceCheck(inspection);
}

export async function inspectDatabaseDoctorHistory(
  input: DatabaseDoctorInput
): Promise<DatabaseDoctorResult> {
  const now = input.now ?? Date.now();
  const statistics = readProjectStatistics(input.database);
  const snapshots = statistics.artifacts.map(({ row }) => {
    const snapshot = readProjectArtifact(input.database, row.artifactId, {
      generation: row.generation,
      orderedHash: row.orderedHash,
      eventCount: row.eventCount,
      byteLength: row.byteLength,
      tailEventId: row.tailEventId,
    });
    if (!snapshot)
      throw new ProjectDatabaseError(
        'HISTORY_INTEGRITY_REQUIRED',
        `Selected artifact revision ${row.artifactId}@${row.generation} is missing; preserve history for explicit repair`
      );
    return snapshot;
  });
  const exactRuns = snapshots.map(({ artifactId, thread }) => ({
    artifactId,
    runs: historyMetadataDetails(thread, null).evaluatorRuns,
  }));
  const executions = new Map<string, NonNullable<ReturnType<typeof readProjectExecution>>>();
  for (const { artifactId } of snapshots) {
    const execution = readProjectExecution(input.database, artifactId);
    if (execution) executions.set(artifactId, execution);
  }
  const accounting = readProjectUsageAccounting(input.database);
  const unavailable = accounting.unavailable ?? [];
  const seed = seedCheck(input.database, statistics, input.historyCommitCount);
  const integrityIssues = statistics.issues;
  const checks: DoctorCheck[] = [
    {
      name: 'history-database',
      status: 'pass',
      summary: `project ${input.database.authority.projectId}, store ${input.database.authority.storeInstanceId}; ${statistics.artifacts.length} artifact(s)`,
    },
    {
      name: 'artifact-integrity',
      status: integrityIssues.length ? 'fail' : 'pass',
      summary: integrityIssues.length
        ? `${integrityIssues.length} retained relationship set(s) could not be reconstructed`
        : `${snapshots.length} retained artifact revision(s) reconstructed exactly`,
      ...(integrityIssues.length
        ? {
            details: integrityIssues.map(
              (issue) =>
                `  - ${issue.artifactId ?? 'project'} ${issue.resource}: ${issue.code} — ${issue.message}`
            ),
          }
        : {}),
    },
    {
      name: 'lineage-identity',
      status: statistics.unknownAssociations ? 'warn' : 'pass',
      summary: statistics.unknownAssociations
        ? `${statistics.unknownAssociations} retained worktree association(s) have unknown historical identity`
        : 'all retained worktree associations have known historical identity',
      ...(statistics.unknownAssociations
        ? { details: ['Preserve unknown associations until their original identity is known.'] }
        : {}),
    },
    staleArtifacts(statistics, now),
    staleOpenCheckpoints(statistics, now),
    unresolvedBlocks(exactRuns),
    ...evaluatorHistory(snapshots, statistics, exactRuns, input.dispositionTtlDays, now),
    {
      name: 'usage-history',
      status: unavailable.length ? 'warn' : 'pass',
      summary: `${accounting.events.length} retained usage event(s) across ${statistics.sessions.length} session(s)`,
      ...(unavailable.length ? { details: [...unavailable] } : {}),
    },
    seed.check,
    pendingPlanCheck(input.database),
    cloudSyncCheck(input.database),
    ...sourcePlanChecks(input.database, snapshots),
    skippedFingerprintCheck(snapshots),
    await lineageCheck(input.context, snapshots),
    {
      name: 'execution-history',
      status: executions.size === snapshots.length ? 'pass' : 'warn',
      summary: `${executions.size}/${snapshots.length} artifact(s) have retained execution state`,
      ...(executions.size === snapshots.length
        ? {}
        : {
            details: [
              'Imported legacy execution may be explicitly unbound; preserve it during repair.',
            ],
          }),
    },
    {
      name: 'session-history',
      status: 'pass',
      summary: hasProjectSessionBranchState(input.database)
        ? 'retained session branch state is present'
        : 'no retained session branch state',
    },
  ];
  if (input.context.git.worktreeId !== null && input.shellKey.kind !== 'none') {
    const focus = readProjectExecutionFocus(input.database, {
      rootKey: input.context.authority.rootKey,
      projectId: input.context.authority.projectId,
      storeInstanceId: input.context.authority.storeInstanceId,
      repositoryInstanceId: input.context.authority.repositoryInstanceId,
      worktreeId: input.context.git.worktreeId,
      shellKey: input.shellKey,
    });
    checks.push({
      name: 'focus',
      status: 'pass',
      summary:
        focus.status === 'present'
          ? `current session focus selects ${focus.pin.artifact_id}`
          : focus.status === 'cleared'
            ? 'current session focus is explicitly cleared'
            : 'current session has no retained focus',
    });
  }
  checks.push(...pinChecks(input.pins, statistics, executions, now));
  checks.push(...retainedPinChecks(snapshots, statistics));
  checks.push(await publicationCheck(input.database, input.context));
  return { checks, seedNeedsRepair: seed.needsRepair };
}
