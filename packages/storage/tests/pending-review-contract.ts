import type { PendingReviewRetention } from '@orcaops/storage/history/database/review-retention';

export function originalReviewInputIsReadonly(value: PendingReviewRetention) {
  // @ts-expect-error The original selected identity is retained.
  value.original.selectedTransitionId = 'changed';
  if (value.original.base) {
    // @ts-expect-error Exact byte projection is readonly.
    value.original.base.bytesHex = '00';
  }
  if (value.original.floor) {
    // @ts-expect-error The original basis is readonly.
    value.original.floor.basis.baseSha = 'changed';
    // @ts-expect-error Original untracked ordering is readonly.
    value.original.floor.basis.reviewIncludedUntracked[0] = 'changed';
    // @ts-expect-error The evidence membership is readonly.
    value.original.floor.members[0] = value.original.floor.members[1]!;
    // @ts-expect-error Original evidence identity is readonly.
    value.original.floor.members[0]!.sha256 = 'changed';
  }
}
