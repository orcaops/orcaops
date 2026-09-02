import serverConfig from '@orcaops/eslint-config/server.js';

export default [
  {
    ignores: ['dist/**', 'node_modules/**', 'bin/**'],
  },
  ...serverConfig,
  {
    // Bare `process.exit()` is reserved for the top-level handler in
    // src/cli/index.ts and the CliExit definition site in src/io/exit.ts.
    // Everywhere else in CLI source must throw `new CliExit(code)` so
    // the in-process test harness can observe exit codes without the
    // vitest worker actually exiting. Test files (in-process + smoke)
    // must not monkey-patch `process.exit` — the ALS-routed fuse lives
    // in `@orcaops/test-harness` (its own ESLint config governs it).
    files: ['src/**/*.ts', 'tests/**/*.ts'],
    ignores: ['src/cli/index.ts', 'src/io/exit.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.object.name='process'][callee.property.name='exit']",
          message:
            'Throw `new CliExit(code)` from src/io/exit.ts instead of calling process.exit. The top-level handler in src/cli/index.ts converts the throw into the real exit.',
        },
      ],
    },
  },
];
