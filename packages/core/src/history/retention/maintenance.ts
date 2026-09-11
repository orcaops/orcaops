import { isDeepStrictEqual } from 'node:util';

import {
  type GitReclamationAdmission,
  type GitReclamationTarget,
  type ProjectDatabase,
  ProjectDatabaseError,
  readProjectGitReclamationInventory,
} from '@orcaops/storage/history/database';

import type { RegisteredDatabaseContext } from '../context/execution.js';
import {
  inspectManagedGitRefs,
  type ManagedGitRefObservation,
} from '../managed-git-ref-inspection.js';

export interface DatabaseMaintenanceResource {
  publicationId: string | null;
  originalOperationId: string | null;
  role?: 'checkpoint' | 'baseline' | 'review-floor' | 'review-floor-base' | 'review-base' | null;
  ownerId?: string | null;
  targetId?: string | null;
  checkpointNumber?: number | null;
  checkpointPhase?: 'open' | 'close' | 'abandon' | null;
  fullRef: string;
  expectedOid: string | null;
  observedOid: string | null;
  symbolicTarget: string | null;
  state: 'eligible' | 'protected' | 'reclaimed';
  reason:
    | 'retired'
    | 'unknown'
    | 'pending'
    | 'selected'
    | 'referenced'
    | 'malformed'
    | 'symbolic'
    | 'dangling'
    | 'conflicting'
    | 'inaccessible'
    | 'already-reclaimed';
  admissionOperationId: string | null;
  target: GitReclamationTarget | null;
}

export interface DatabaseMaintenanceInspection {
  authority: RegisteredDatabaseContext['authority'];
  resources: DatabaseMaintenanceResource[];
  pendingAdmissions: GitReclamationAdmission[];
  completeness: {
    complete: boolean;
    issues: readonly { code: string; message: string; resourceId: string | null }[];
  };
}

function protectedObservationReason(
  observation: ManagedGitRefObservation
): DatabaseMaintenanceResource['reason'] | null {
  if (observation.symbolicTarget) return 'symbolic';
  if (observation.issue) return observation.oid === null ? 'dangling' : 'malformed';
  return null;
}

export async function inspectDatabaseMaintenance(
  handle: ProjectDatabase,
  context: RegisteredDatabaseContext
): Promise<DatabaseMaintenanceInspection> {
  if (!isDeepStrictEqual(handle.authority, context.authority))
    throw new ProjectDatabaseError(
      'AUTHORITY_MISMATCH',
      'Use the registered project database that owns this Git namespace'
    );

  const inventory = readProjectGitReclamationInventory(handle).value;
  const namespace = await inspectManagedGitRefs(context.git.worktreeRoot, context.git.commonDir);
  const observations = new Map(namespace.refs.map((ref) => [ref.fullRef, ref]));
  const publicationsByRef = new Map<string, number>();
  for (const publication of inventory.publications)
    publicationsByRef.set(
      publication.fullRef,
      (publicationsByRef.get(publication.fullRef) ?? 0) + 1
    );
  const admissionsByPublication = new Map<string, (typeof inventory.admissions)[number][]>();
  for (const admission of inventory.admissions) {
    const publicationId = admission.input.target.publicationId;
    admissionsByPublication.set(publicationId, [
      ...(admissionsByPublication.get(publicationId) ?? []),
      admission,
    ]);
  }

  const resources: DatabaseMaintenanceResource[] = inventory.publications.map((publication) => {
    const observation = observations.get(publication.fullRef);
    observations.delete(publication.fullRef);
    const admissions = admissionsByPublication.get(publication.publicationId) ?? [];
    const pendingAdmission = admissions.find((admission) => !admission.terminal)?.input ?? null;
    const completedAdmission = admissions.some((admission) => admission.terminal);
    const base = {
      publicationId: publication.publicationId,
      originalOperationId: publication.originalOperationId,
      role: publication.role,
      ownerId: publication.ownerId,
      targetId: publication.targetId,
      checkpointNumber: publication.checkpointNumber,
      checkpointPhase: publication.checkpointPhase,
      fullRef: publication.fullRef,
      expectedOid: publication.objectOid,
      observedOid: observation?.oid ?? null,
      symbolicTarget: observation?.symbolicTarget ?? null,
      admissionOperationId: pendingAdmission?.admissionOperationId ?? null,
      target: publication.preview.status === 'eligible' ? publication.preview.target : null,
    };
    if (!namespace.issues.length && (publicationsByRef.get(publication.fullRef) ?? 0) > 1)
      return { ...base, state: 'protected' as const, reason: 'conflicting' as const };
    if (namespace.issues.length)
      return { ...base, state: 'protected' as const, reason: 'inaccessible' as const };
    if (observation) {
      const unsafe = protectedObservationReason(observation);
      if (unsafe) return { ...base, state: 'protected' as const, reason: unsafe };
      if (observation.oid !== publication.objectOid)
        return { ...base, state: 'protected' as const, reason: 'conflicting' as const };
    }
    if (publication.preview.status === 'protected')
      return {
        ...base,
        state: 'protected' as const,
        reason: publication.preview.reason,
      };
    if (!observation && !pendingAdmission && completedAdmission)
      return { ...base, state: 'reclaimed' as const, reason: 'already-reclaimed' as const };
    return { ...base, state: 'eligible' as const, reason: 'retired' as const };
  });

  for (const observation of observations.values()) {
    const unsafe = protectedObservationReason(observation);
    resources.push({
      publicationId: null,
      originalOperationId: null,
      role: null,
      ownerId: null,
      targetId: null,
      checkpointNumber: null,
      checkpointPhase: null,
      fullRef: observation.fullRef,
      expectedOid: null,
      observedOid: observation.oid,
      symbolicTarget: observation.symbolicTarget,
      state: 'protected',
      reason: namespace.issues.length ? 'inaccessible' : (unsafe ?? 'unknown'),
      admissionOperationId: null,
      target: null,
    });
  }

  return {
    authority: structuredClone(context.authority),
    resources: resources.sort((left, right) => left.fullRef.localeCompare(right.fullRef)),
    pendingAdmissions: inventory.admissions
      .filter((record) => !record.terminal)
      .map((record) => structuredClone(record.input)),
    completeness: {
      complete: namespace.issues.length === 0,
      issues: namespace.issues.map((issue) => ({ ...issue })),
    },
  };
}
