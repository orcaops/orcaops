import { describe, expect, test } from 'bun:test';

import {
  mountedHarnessGlobalLeaseCount,
  mountReviewApp,
} from '../../../tests/review/mountReviewApp';

describe('mounted harness global lifecycle', () => {
  test('a failed mount releases every process-global hook', async () => {
    const stdoutBefore = process.stdout.write;
    await expect(
      mountReviewApp({ scenario: 'no-narrative', failAfterHarnessHooks: true })
    ).rejects.toThrow('mounted harness fault');
    expect(mountedHarnessGlobalLeaseCount()).toBe(0);
    expect(process.stdout.write).toBe(stdoutBefore);
  });

  test('nested mounts can unmount out of order without clobbering the survivor', async () => {
    const stdoutBefore = process.stdout.write;
    const first = await mountReviewApp({ scenario: 'no-narrative' });
    const second = await mountReviewApp({ scenario: 'no-narrative', screen: 'floor-diff' });
    expect(mountedHarnessGlobalLeaseCount()).toBe(2);

    first.unmount();
    expect(mountedHarnessGlobalLeaseCount()).toBe(1);
    expect(process.stdout.write).not.toBe(stdoutBefore);
    await second.pressAll(['j', '\r', 'v', 'j', 'Y']);
    expect(second.clipboardWrites()).toContain('second fixture hunk');

    second.unmount();
    expect(mountedHarnessGlobalLeaseCount()).toBe(0);
    expect(process.stdout.write).toBe(stdoutBefore);
  });

  test('last-in-first-out cleanup is idempotent too', async () => {
    const stdoutBefore = process.stdout.write;
    const first = await mountReviewApp({ scenario: 'no-narrative' });
    const second = await mountReviewApp({ scenario: 'no-narrative' });
    second.unmount();
    second.unmount();
    expect(mountedHarnessGlobalLeaseCount()).toBe(1);
    first.unmount();
    expect(mountedHarnessGlobalLeaseCount()).toBe(0);
    expect(process.stdout.write).toBe(stdoutBefore);
  });
});
