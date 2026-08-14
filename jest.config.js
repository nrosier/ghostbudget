module.exports = {
  testEnvironment: 'node',
  clearMocks: true,
  resetMocks: true,
  restoreMocks: true,
  moduleDirectories: ['node_modules', 'src'],
  verbose: true,
  setupFilesAfterEnv: ['<rootDir>/jest.setup.js'],
  // Transform ESM modules from node_modules
  transformIgnorePatterns: ['node_modules/(?!(uuid)/)'],

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
      statements: 92,
      branches: 88,
      functions: 88,
      lines: 92,
    },
    './src/utils/validation.js': {
      statements: 100,
      branches: 95,
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
    // The remaining gaps here are retry and circuit-breaker paths that need a real
    // clock to reach; the resilience suite covers the behaviour, not every branch.
    './src/ghostfolio.js': {
      statements: 88,
      branches: 82,
      functions: 82,
      lines: 88,
    },
    './src/config/': {
      statements: 100,
      branches: 60,
      functions: 100,
      lines: 100,
    },
  },
};
