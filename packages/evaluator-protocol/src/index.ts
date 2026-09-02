export const PACKAGE_NAME = '@orcaops/evaluator-protocol';

export * from './schemas/index.js';
export * from './resolve.js';
export * from './capture-exclude.js';
export * from './containment.js';
export * from './context-block.js';
export * from './verdict.js';
export {
  globMayMatchDescendant,
  globRequiresDirectoryTraversal,
  isValidGlobSyntax,
  matchesAnyGlob,
  toPosixPath,
} from './glob.js';
