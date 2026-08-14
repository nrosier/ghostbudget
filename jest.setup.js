const nock = require('nock');

// No test may open a socket. The suites point at http://localhost:3333, which is
// Ghostfolio's own default port, so without this a test missing an interceptor sends a
// real balance PUT to whatever is listening on the developer's machine. It is also what
// makes every "no request was sent" assertion load-bearing. See docs/decisions.md.
nock.disableNetConnect();

// Mock browser globals for @actual-app/api
global.navigator = {
  userAgent: 'node.js',
};

// Set test environment
process.env.NODE_ENV = 'test';

// Silence the console, in a hook rather than at module scope: jest.config.js sets
// `restoreMocks: true`, so Jest calls restoreAllMocks() before every test and would
// strip spies installed at module scope after the first one. From a setup file's
// beforeEach they survive, because Jest's internal restore runs first.
//
// No jest.clearAllMocks() hook either — `resetMocks: true` already does it. See
// docs/decisions.md.
beforeEach(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
