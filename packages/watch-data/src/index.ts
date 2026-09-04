// The Watch data layer: the snapshot engine the Node sidecar runs, its
// collectors, and the shapes the UI reads. Consumers under Node import this;
// the Bun UI imports only `./ui`.
export * from './ui.js';
export * from './engine.js';
export * from './snapshot.js';
export * from './fs-watch.js';
export * from './event-tail.js';
