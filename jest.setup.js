const nock = require('nock');

// No test may open a socket. The suites point at http://localhost:3333, which is
// Ghostfolio's own default port, so a test missing an interceptor did not fail —
// it sent a real balance PUT to whatever was listening on the developer's machine.
// This also makes every "no request was sent" assertion load-bearing: without it,
// a scope's `isDone() === false` only proves nock did not serve the request, not
// that nothing was sent.
nock.disableNetConnect();

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
