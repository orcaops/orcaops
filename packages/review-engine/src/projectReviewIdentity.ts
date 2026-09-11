import { z } from 'zod';

import { UuidV7Schema } from '@orcaops/storage';

const ObjectIdSchema = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);

export const ProjectReviewIdentitySchema = z
  .strictObject({
    schema_version: z.literal(1),
    review_id: UuidV7Schema,
    project_id: UuidV7Schema,
    store_instance_id: UuidV7Schema,
    repository_instance_id: UuidV7Schema.nullable(),
    created_by_operation: UuidV7Schema,
    initial_context: z.strictObject({
      worktree_id: UuidV7Schema.nullable(),
      branch: z.string().min(1).nullable(),
      base_sha: ObjectIdSchema.nullable(),
      head_sha: ObjectIdSchema.nullable(),
    }),
    artifact_ids: z.array(UuidV7Schema),
    legacy_source_ids: z.array(z.string().min(1)),
  })
  .superRefine((identity, context) => {
    for (const field of ['artifact_ids', 'legacy_source_ids'] as const) {
      if (new Set(identity[field]).size !== identity[field].length)
        context.addIssue({
          code: 'custom',
          path: [field],
          message: 'Identity contains duplicates',
        });
    }
    if (identity.initial_context.worktree_id !== null && identity.repository_instance_id === null)
      context.addIssue({
        code: 'custom',
        path: ['initial_context', 'worktree_id'],
        message: 'Worktree identity requires repository identity',
      });
  });

export type ProjectReviewIdentity = z.infer<typeof ProjectReviewIdentitySchema>;
