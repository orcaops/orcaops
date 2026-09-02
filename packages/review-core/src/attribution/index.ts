// The snapshot-chain attribution engine. Pure: the sidecar injects
// git output and file contents; the engine builds the chain, rolls up coverage,
// runs the degradation ladder, cross-checks integrity, and downgrades overlaps.

export * from './chain.js';
export * from './changedRows.js';
export * from './ladder.js';
export * from './integrity.js';
export * from './coverage.js';
export * from './units.js';
