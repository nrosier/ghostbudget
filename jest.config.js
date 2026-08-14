module.exports = {
  testEnvironment: 'node',
  clearMocks: true,
  resetMocks: true,
  restoreMocks: true,
  moduleDirectories: ['node_modules', 'src'],
  verbose: true,
  setupFilesAfterEnv: ['<rootDir>/jest.setup.js'],

  // Report on every source file, not only the ones a test happened to import: a
  // module with no test at all is exactly what a coverage report should surface,
  // and by default Jest omits it entirely.
  collectCoverageFrom: ['src/**/*.js'],

  // Thresholds, so the numbers are a gate rather than a report nobody reads. They
  // are set at, or just under, what the suite achieves today — the point is to stop
  // coverage sliding backwards, not to pass by leaving room to remove tests.
  //
  // Note on how Jest groups these: a file matched by a per-path entry is removed
  // from the `global` group entirely, rather than being counted in both. So `global`
  // here means "everything without its own entry below" — src/actualBudget.js,
  // src/healthcheck.js, src/index.js, src/scheduler.js and src/utils/exit.js.
  coverageThreshold: {
    global: {
      statements: 96,
      branches: 92,
      // 91.89 is the ceiling, not a gap to close: the shortfall is index.js's
      // `require.main === module` block, whose two callbacks cannot run in a module
      // a test has required. Reaching them means spawning a subprocess.
      functions: 91,
      lines: 96,
    },
    './src/utils/validation.js': {
      statements: 100,
      // 99.1 is the ceiling: the remaining branch is the `process.getuid` fallback in
      // validateDataDir, which only has a second arm on Windows.
      branches: 99,
      functions: 100,
      lines: 100,
    },
    './src/utils/audit.js': {
      statements: 100,
      branches: 84,
      functions: 100,
      lines: 100,
    },
    './src/logger.js': {
      statements: 100,
      branches: 83,
      functions: 100,
      lines: 100,
    },
    // The remaining gaps here are axios-retry's `retryDelay` and `onRetry`
    // callbacks, which need a real clock to reach — which is also why `functions`
    // sits well below the others. Raise these to whatever the suite achieves.
    './src/ghostfolio.js': {
      statements: 98,
      branches: 97,
      functions: 87,
      lines: 98,
    },
    './src/config/': {
      statements: 100,
      branches: 75,
      functions: 100,
      lines: 100,
    },
  },
};
