import { afterEach } from 'vitest';

/**
 * One `afterEach` for the whole harness, so the order between killing processes
 * and deleting the roots they are running inside is explicit rather than an
 * accident of module import order.
 *
 * `children` runs first: a live child holds an open database handle inside a
 * disposable root, and on macOS removing the tree under a running process leaves
 * the scenario's failure message describing a missing file instead of the real
 * fault. `roots` runs after every child has exited.
 */
type Phase = 'children' | 'roots';

const handlers: Record<Phase, (() => Promise<void>)[]> = { children: [], roots: [] };

export function registerCleanup(phase: Phase, handler: () => Promise<void>) {
  handlers[phase].push(handler);
}

afterEach(async () => {
  for (const phase of ['children', 'roots'] as const)
    for (const handler of handlers[phase]) await handler();
});
