// Mock browser globals for @actual-app/api
global.navigator = {
  userAgent: 'node.js',
};

// Log when mocks are created
jest.spyOn(console, 'log').mockImplementation(() => {});
jest.spyOn(console, 'error').mockImplementation(() => {});
jest.spyOn(console, 'warn').mockImplementation(() => {});

beforeEach(() => {
  jest.clearAllMocks();
});

// Set test environment
process.env.NODE_ENV = 'test';

// The `uuid` package used to be mocked here, because it ships as ESM and Jest
// could not load it. Correlation IDs now come from crypto.randomUUID(), which
// needs neither the mock nor the transformIgnorePatterns entry in jest.config.js.
