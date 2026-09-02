// @orcaops/review-core — pure, dependency-light contracts for Task Review.
//
// No `fs` / `child_process` here: the sidecar injects git output and file
// contents, and the Bun UI imports these same contracts type-first. Everything
// the floor, journal, comments, and TUI share is defined
// once, here.

export * from './attribution/index.js';
export * from './comments.js';
export * from './coverageState.js';
export * from './enums.js';
export * from './floorFixtures.js';
export * from './keys.js';
export * from './ledger.js';
export * from './protocol.js';
export * from './reviewState.js';
export * from './schema.js';
export * from './slug.js';
