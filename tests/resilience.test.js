const nock = require('nock');

const constants = require('../src/config/constants');

// The rate limiter and the circuit breaker are both documented as controls, and
// neither was exercised anywhere. These tests go through the same private request
// path the public methods use, because that is where both controls sit.
describe('resilience controls', () => {
  const baseUrl = 'http://localhost:3333';
  let ghostfolio;

  beforeEach(() => {
    jest.resetModules();
    nock.cleanAll();

    process.env.GHOSTFOLIO_URL = baseUrl;
    process.env.GHOSTFOLIO_TOKEN = '0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9';
    process.env.ACTUAL_BUDGET_URL = 'http://localhost:5006';
    process.env.ACTUAL_BUDGET_PASS = 'test-pass';
    process.env.ACTUAL_BUDGET_SYNC_ID = 'test-sync-id';
    process.env.NODE_ENV = 'test';

    ghostfolio = require('../src/ghostfolio');
  });

  afterEach(() => {
    nock.cleanAll();
    ghostfolio.breaker.close();
  });

  describe('rate limiter', () => {
    it('is on the request path, not merely constructed', () => {
      // The limiter used to be a bare RateLimiterMemory, which rejects with a
      // RateLimiterRes rather than an Error when the limit is exceeded — breaking
      // every downstream path that reads `.message` and turning a throttle into a
      // lost balance update. It is now a queue, so a request waits for a slot.
      expect(typeof ghostfolio.rateLimiter.removeTokens).toBe('function');
      expect(constants.RATE_LIMIT_MAX_QUEUE).toBeGreaterThan(0);
    });

    it('consumes exactly one token per request', async () => {
      const removeTokens = jest.spyOn(ghostfolio.rateLimiter, 'removeTokens');

      nock(baseUrl).get('/ping').twice().reply(200, {});

      await ghostfolio._apiRequest({ method: 'GET', url: `${baseUrl}/ping` });
      await ghostfolio._apiRequest({ method: 'GET', url: `${baseUrl}/ping` });

      expect(removeTokens).toHaveBeenCalledTimes(2);
      expect(removeTokens).toHaveBeenCalledWith(1);
    });

    it('queues requests past the limit instead of rejecting them', async () => {
      const overLimit = constants.RATE_LIMIT_POINTS + 2;
      nock(baseUrl).get('/ping').times(overLimit).reply(200, {});

      const startedAt = Date.now();
      const results = await Promise.all(
        Array.from({ length: overLimit }, () =>
          ghostfolio._apiRequest({ method: 'GET', url: `${baseUrl}/ping` })
        )
      );
      const elapsed = Date.now() - startedAt;

      // Every request succeeded — none was dropped...
      expect(results).toHaveLength(overLimit);
      for (const response of results) {
        expect(response.status).toBe(200);
      }
      // ...and the ones past the limit waited for the next window rather than
      // failing, which is the whole point of the queue.
      expect(elapsed).toBeGreaterThan(constants.RATE_LIMIT_DURATION * 1000 * 0.5);
      expect(nock.isDone()).toBe(true);
    }, 15000);
  });

  describe('circuit breaker', () => {
    it('allows longer than the worst case of a fully-retried request chain', () => {
      // If the breaker's timeout is shorter than the retry chain it wraps, it fires
      // on requests that are merely retrying: it records a failure, and because
      // opossum does not cancel the action it wrapped, the request continues and
      // can still succeed — leaving the audit trail contradicting reality.
      const attempts = ghostfolio.maxRetries + 1;
      const worstCase =
        attempts * constants.HTTP_TIMEOUT_MS + ghostfolio.maxRetries * constants.MAX_RETRY_DELAY_MS;

      expect(ghostfolio.breaker.options.timeout).toBe(
        constants.circuitBreakerTimeoutFor(ghostfolio.maxRetries)
      );
      expect(ghostfolio.breaker.options.timeout).toBeGreaterThan(worstCase);
    });

    it('opens after sustained failures and then short-circuits without a request', async () => {
      // A 400 is used because axios-retry does not retry it, so each call is one
      // deterministic failure rather than a retry chain.
      nock(baseUrl).get('/ping').times(20).reply(400, {});

      for (let i = 0; i < 20 && !ghostfolio.breaker.opened; i += 1) {
        await expect(
          ghostfolio._apiRequest({ method: 'GET', url: `${baseUrl}/ping` })
        ).rejects.toThrow();
      }

      expect(ghostfolio.breaker.opened).toBe(true);

      // While open, the breaker must reject locally. No interceptor is registered
      // for this path, so a request reaching the network would fail differently.
      await expect(
        ghostfolio._apiRequest({ method: 'GET', url: `${baseUrl}/never-called` })
      ).rejects.toThrow(/Breaker is open/i);
    }, 20000);

    it('reports an open breaker as a security event', async () => {
      const AuditLogger = require('../src/utils/audit');
      const logSecurityEvent = jest.spyOn(AuditLogger, 'logSecurityEvent');

      ghostfolio.breaker.open();

      expect(logSecurityEvent).toHaveBeenCalledWith(
        'circuit_breaker_open',
        'high',
        expect.objectContaining({ service: 'ghostfolio' })
      );
    });

    it('passes a successful response through untouched', async () => {
      nock(baseUrl).get('/ping').reply(200, { pong: true });

      const response = await ghostfolio._apiRequest({ method: 'GET', url: `${baseUrl}/ping` });

      expect(response.data).toEqual({ pong: true });
      expect(ghostfolio.breaker.opened).toBe(false);
    });
  });
});
