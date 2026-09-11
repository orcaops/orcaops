// The Watch data layer: the snapshot engine the Node sidecar runs, its
// collectors, and the shapes the UI reads. Consumers under Node import this;
// the Bun UI imports only `./ui`.
export * from './ui.js';
export * from './history-engine.js';
export * from './fs-watch.js';
