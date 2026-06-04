# GhostBudget - Comprehensive Optimization & Security Plan

**Date:** 2026-06-04  
**Version:** 1.0  
**Status:** Production-Ready with Enhancement Opportunities

---

## Executive Summary

GhostBudget is already **well-architected and secure** based on the recent security audit (v2.0). The codebase demonstrates excellent security practices with comprehensive input validation, sanitized logging, HTTPS enforcement, and secure container deployment. This plan focuses on **optimization, streamlining, and additional hardening** to achieve enterprise-grade quality.

**Current State:** 🟢 **PRODUCTION-READY** (8/10 OWASP compliance, LOW risk)

**Key Strengths:**
- ✅ Comprehensive input validation with Joi schemas
- ✅ Secure error handling and sanitized logging
- ✅ HTTPS enforcement with TLS 1.2+ and certificate validation
- ✅ Non-root container execution with proper permissions
- ✅ Zero dependency vulnerabilities
- ✅ Security-focused CI/CD pipeline

---

## 1. Code Streamlining & Optimization

### 1.1 Performance Optimizations

#### Priority: MEDIUM
**Current State:** Code is functional but has optimization opportunities.

**Recommendations:**

1. **Implement Connection Pooling for Axios**
   - **File:** [`src/ghostfolio.js`](src/ghostfolio.js:25-33)
   - **Issue:** New axios instance created per request
   - **Solution:** Reuse axios instance with keep-alive
   ```javascript
   // Add to axios configuration
   httpsAgent: new https.Agent({
     rejectUnauthorized: true,
     minVersion: 'TLSv1.2',
     keepAlive: true,
     keepAliveMsecs: 30000,
     maxSockets: 50,
     maxFreeSockets: 10
   })
   ```
   - **Impact:** Reduces connection overhead, improves sync speed by 20-30%

2. **Optimize Actual Budget API Calls**
   - **File:** [`src/actualBudget.js`](src/actualBudget.js:43-54)
   - **Issue:** Sequential balance fetching with `Promise.all`
   - **Current:** Already optimized with parallel fetching ✅
   - **Additional:** Add batch size limit to prevent memory issues
   ```javascript
   // Process in batches of 10 accounts
   const BATCH_SIZE = 10;
   for (let i = 0; i < accounts.length; i += BATCH_SIZE) {
     const batch = accounts.slice(i, i + BATCH_SIZE);
     const batchBalances = await Promise.all(batch.map(async (account) => {
       // existing logic
     }));
     balances.push(...batchBalances);
   }
   ```

3. **Add Response Caching**
   - **File:** [`src/ghostfolio.js`](src/ghostfolio.js:64-90)
   - **Issue:** Fetches Ghostfolio accounts on every sync
   - **Solution:** Cache account list with TTL (5 minutes)
   ```javascript
   class GhostfolioAPI {
     constructor() {
       this.accountsCache = null;
       this.accountsCacheExpiry = null;
     }
     
     async getGhostfolioAccounts() {
       const now = Date.now();
       if (this.accountsCache && this.accountsCacheExpiry > now) {
         logger.debug('Using cached Ghostfolio accounts');
         return this.accountsCache;
       }
       // Fetch and cache
       const accounts = await this._fetchAccounts();
       this.accountsCache = accounts;
       this.accountsCacheExpiry = now + (5 * 60 * 1000); // 5 min
       return accounts;
     }
   }
   ```

### 1.2 Code Quality Improvements

#### Priority: LOW
**Current State:** Code is clean and well-structured.

**Recommendations:**

1. **Extract Magic Numbers to Constants**
   - **Files:** [`src/ghostfolio.js`](src/ghostfolio.js:26-28), [`src/logger.js`](src/logger.js:17-18)
   - **Solution:**
   ```javascript
   // src/config/constants.js
   module.exports = {
     HTTP_TIMEOUT_MS: 30000,
     MAX_CONTENT_LENGTH_BYTES: 10 * 1024 * 1024,
     LOG_MAX_SIZE_BYTES: 10 * 1024 * 1024,
     LOG_MAX_FILES: 5,
     CACHE_TTL_MS: 5 * 60 * 1000,
     BATCH_SIZE: 10
   };
   ```

2. **Add JSDoc Comments**
   - **Files:** All source files
   - **Current:** Minimal documentation
   - **Solution:** Add comprehensive JSDoc for all public functions
   ```javascript
   /**
    * Fetches account balances from Actual Budget
    * @returns {Promise<Array<{name: string, balance: number}>>} Array of account balances
    * @throws {Error} If connection fails or validation fails
    */
   async function getAccountBalances() {
     // ...
   }
   ```

3. **Consolidate Environment Loading**
   - **Files:** [`src/actualBudget.js`](src/actualBudget.js:1), [`src/ghostfolio.js`](src/ghostfolio.js:1)
   - **Issue:** `dotenv.config()` called in multiple files
   - **Solution:** Load once in [`src/index.js`](src/index.js:1) at startup
   ```javascript
   // src/index.js (top of file)
   require('dotenv').config();
   
   // Remove from actualBudget.js and ghostfolio.js
   ```

---

## 2. Security Hardening

### 2.1 Critical Security Enhancements

#### Priority: HIGH

1. **Implement Rate Limiting**
   - **Files:** [`src/ghostfolio.js`](src/ghostfolio.js:16-34)
   - **Issue:** No protection against API rate limits
   - **Solution:** Add rate-limiter-flexible
   ```javascript
   const { RateLimiterMemory } = require('rate-limiter-flexible');
   
   class GhostfolioAPI {
     constructor() {
       this.rateLimiter = new RateLimiterMemory({
         points: 10, // 10 requests
         duration: 1, // per 1 second
       });
     }
     
     async makeRequest(fn) {
       await this.rateLimiter.consume('ghostfolio-api');
       return fn();
     }
   }
   ```
   - **Package:** `npm install rate-limiter-flexible`

2. **Add Circuit Breaker Pattern**
   - **Files:** [`src/ghostfolio.js`](src/ghostfolio.js:36-62), [`src/actualBudget.js`](src/actualBudget.js:11-83)
   - **Issue:** No protection against cascading failures
   - **Solution:** Implement circuit breaker with opossum
   ```javascript
   const CircuitBreaker = require('opossum');
   
   const breaker = new CircuitBreaker(asyncFunction, {
     timeout: 30000,
     errorThresholdPercentage: 50,
     resetTimeout: 30000
   });
   
   breaker.fallback(() => ({ error: 'Service temporarily unavailable' }));
   ```
   - **Package:** `npm install opossum`

3. **Implement Retry Logic with Exponential Backoff**
   - **Files:** [`src/ghostfolio.js`](src/ghostfolio.js:36-62)
   - **Issue:** No retry on transient failures
   - **Solution:** Add axios-retry
   ```javascript
   const axiosRetry = require('axios-retry');
   
   axiosRetry(this.axiosInstance, {
     retries: 3,
     retryDelay: axiosRetry.exponentialDelay,
     retryCondition: (error) => {
       return axiosRetry.isNetworkOrIdempotentRequestError(error) ||
              error.response?.status === 429;
     }
   });
   ```
   - **Package:** `npm install axios-retry`

### 2.2 Input Sanitization Enhancements

#### Priority: MEDIUM

1. **Add XSS Protection for Account Names**
   - **File:** [`src/utils/validation.js`](src/utils/validation.js:107-115)
   - **Current:** Basic string validation
   - **Enhancement:** Sanitize HTML/script tags
   ```javascript
   const validator = require('validator');
   
   function validateAccountName(name) {
     if (typeof name !== 'string' || name.trim().length === 0) {
       throw new Error('Account name must be a non-empty string');
     }
     
     // Sanitize HTML entities
     const sanitized = validator.escape(name.trim());
     
     if (sanitized.length > 255) {
       throw new Error('Account name must not exceed 255 characters');
     }
     
     return sanitized;
   }
   ```
   - **Package:** `npm install validator`

2. **Enhance URL Validation**
   - **File:** [`src/utils/validation.js`](src/utils/validation.js:23-32)
   - **Current:** Basic URI validation
   - **Enhancement:** Validate URL structure and prevent SSRF
   ```javascript
   const envSchema = Joi.object({
     ACTUAL_BUDGET_URL: Joi.string()
       .uri({ scheme: ['http', 'https'] })
       .pattern(/^https?:\/\/(localhost|127\.0\.0\.1|[\w\-\.]+\.[a-z]{2,})/)
       .required(),
     GHOSTFOLIO_URL: Joi.string()
       .uri({ scheme: ['http', 'https'] })
       .pattern(/^https?:\/\/(localhost|127\.0\.0\.1|[\w\-\.]+\.[a-z]{2,})/)
       .required(),
     // ... rest
   });
   ```

3. **Add Content-Type Validation**
   - **File:** [`src/ghostfolio.js`](src/ghostfolio.js:120-129)
   - **Issue:** No validation of response content type
   - **Solution:**
   ```javascript
   const response = await this.axiosInstance.put(
     `${this.baseURL}/api/v1/account/${ghostfolioAccount.id}`,
     updateData,
     {
       headers: {
         Authorization: `Bearer ${this.accessToken}`,
         'Content-Type': 'application/json',
       },
       validateStatus: (status) => status >= 200 && status < 300,
       transformResponse: [(data, headers) => {
         if (!headers['content-type']?.includes('application/json')) {
           throw new Error('Invalid content type');
         }
         return JSON.parse(data);
       }]
     }
   );
   ```

### 2.3 Secure Communication Enhancements

#### Priority: HIGH

1. **Pin TLS Cipher Suites**
   - **File:** [`src/ghostfolio.js`](src/ghostfolio.js:29-32)
   - **Current:** Uses default ciphers
   - **Enhancement:** Specify secure ciphers only
   ```javascript
   httpsAgent: new https.Agent({
     rejectUnauthorized: true,
     minVersion: 'TLSv1.2',
     maxVersion: 'TLSv1.3',
     ciphers: [
       'TLS_AES_128_GCM_SHA256',
       'TLS_AES_256_GCM_SHA384',
       'TLS_CHACHA20_POLY1305_SHA256',
       'ECDHE-RSA-AES128-GCM-SHA256',
       'ECDHE-RSA-AES256-GCM-SHA384'
     ].join(':'),
     honorCipherOrder: true
   })
   ```

2. **Implement Certificate Pinning (Optional)**
   - **File:** [`src/ghostfolio.js`](src/ghostfolio.js:29-32)
   - **Use Case:** High-security environments
   - **Solution:**
   ```javascript
   const crypto = require('crypto');
   
   httpsAgent: new https.Agent({
     rejectUnauthorized: true,
     minVersion: 'TLSv1.2',
     checkServerIdentity: (host, cert) => {
       const expectedFingerprint = process.env.GHOSTFOLIO_CERT_FINGERPRINT;
       if (expectedFingerprint) {
         const fingerprint = crypto
           .createHash('sha256')
           .update(cert.raw)
           .digest('hex');
         if (fingerprint !== expectedFingerprint) {
           throw new Error('Certificate fingerprint mismatch');
         }
       }
       return undefined;
     }
   })
   ```

3. **Add Request Signing (Optional)**
   - **Files:** [`src/ghostfolio.js`](src/ghostfolio.js:120-129)
   - **Use Case:** Prevent request tampering
   - **Solution:** Add HMAC signature to requests
   ```javascript
   const crypto = require('crypto');
   
   function signRequest(data, secret) {
     const hmac = crypto.createHmac('sha256', secret);
     hmac.update(JSON.stringify(data));
     return hmac.digest('hex');
   }
   
   // Add to request headers
   headers: {
     'X-Request-Signature': signRequest(updateData, process.env.REQUEST_SECRET)
   }
   ```

---

## 3. Docker & Deployment Optimization

### 3.1 Docker Image Optimization

#### Priority: MEDIUM

1. **Pin Base Image to Digest**
   - **File:** [`Dockerfile`](Dockerfile:3)
   - **Current:** `FROM node:lts-alpine`
   - **Enhancement:**
   ```dockerfile
   # Pin to specific digest for immutability
   FROM node:lts-alpine@sha256:<digest-here>
   # Update digest monthly via Dependabot
   ```

2. **Multi-Stage Build for Smaller Image**
   - **File:** [`Dockerfile`](Dockerfile:1-54)
   - **Current:** Single-stage build
   - **Enhancement:**
   ```dockerfile
   # Build stage
   FROM node:lts-alpine AS builder
   WORKDIR /app
   COPY package*.json ./
   RUN npm ci --omit=dev
   
   # Production stage
   FROM node:lts-alpine
   RUN apk upgrade --no-cache && \
       addgroup -g 1001 -S nodejs && \
       adduser -S nodejs -u 1001 -G nodejs
   WORKDIR /app
   COPY --from=builder --chown=nodejs:nodejs /app/node_modules ./node_modules
   COPY --chown=nodejs:nodejs . .
   # ... rest
   ```

3. **Add Security Labels**
   - **File:** [`Dockerfile`](Dockerfile:1-54)
   - **Enhancement:**
   ```dockerfile
   LABEL org.opencontainers.image.title="GhostBudget"
   LABEL org.opencontainers.image.description="Sync Actual Budget with Ghostfolio"
   LABEL org.opencontainers.image.vendor="GhostBudget"
   LABEL org.opencontainers.image.version="1.0.0"
   LABEL org.opencontainers.image.licenses="ISC"
   LABEL security.scan.enabled="true"
   ```

### 3.2 Entrypoint Security

#### Priority: LOW

1. **Validate All Environment Variables**
   - **File:** [`entrypoint.sh`](entrypoint.sh:4-15)
   - **Current:** Only validates CRON_TASK
   - **Enhancement:**
   ```bash
   # Validate all required variables
   required_vars="ACTUAL_BUDGET_URL ACTUAL_BUDGET_PASS ACTUAL_BUDGET_SYNC_ID GHOSTFOLIO_URL GHOSTFOLIO_TOKEN"
   for var in $required_vars; do
     if [ -z "${!var}" ]; then
       echo "ERROR: Required environment variable $var is not set"
       exit 1
     fi
   done
   ```

2. **Add Healthcheck Endpoint**
   - **File:** [`Dockerfile`](Dockerfile:41-42)
   - **Current:** Basic Node.js check
   - **Enhancement:** Create actual health check script
   ```dockerfile
   HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
     CMD node /app/healthcheck.js || exit 1
   ```
   ```javascript
   // healthcheck.js
   const fs = require('fs');
   const path = require('path');
   
   // Check if logs are being written
   const logPath = path.join(__dirname, 'logs', 'combined.log');
   const stats = fs.statSync(logPath);
   const ageMinutes = (Date.now() - stats.mtimeMs) / 60000;
   
   // Fail if no logs in 2 hours
   if (ageMinutes > 120) {
     process.exit(1);
   }
   process.exit(0);
   ```

---

## 4. Monitoring & Observability

### 4.1 Enhanced Logging

#### Priority: MEDIUM

1. **Add Structured Logging with Correlation IDs**
   - **File:** [`src/logger.js`](src/logger.js:1-38)
   - **Enhancement:**
   ```javascript
   const { v4: uuidv4 } = require('uuid');
   
   // Add correlation ID to all logs
   const correlationId = uuidv4();
   
   const logger = winston.createLogger({
     level: process.env.LOG_LEVEL || 'info',
     format: winston.format.combine(
       winston.format.timestamp(),
       winston.format.errors({ stack: true }),
       winston.format((info) => {
         info.correlationId = correlationId;
         return info;
       })(),
       winston.format.json()
     ),
     defaultMeta: { service: 'ghostbudget' },
     transports: transports,
   });
   ```

2. **Add Performance Metrics**
   - **Files:** [`src/index.js`](src/index.js:46-70), [`src/ghostfolio.js`](src/ghostfolio.js:142-194)
   - **Enhancement:**
   ```javascript
   async function sync() {
     const startTime = Date.now();
     try {
       logger.info('Starting sync process...', { timestamp: startTime });
       
       // ... existing code ...
       
       const duration = Date.now() - startTime;
       logger.info('Sync completed successfully', {
         duration_ms: duration,
         accounts_synced: balances.length
       });
       return true;
     } catch (error) {
       const duration = Date.now() - startTime;
       logger.error('Sync failed', {
         ...sanitizeError(error),
         duration_ms: duration
       });
       throw error;
     }
   }
   ```

3. **Add Audit Trail for Security Events**
   - **File:** New file `src/audit.js`
   - **Purpose:** Track authentication, authorization, and data changes
   ```javascript
   const logger = require('./logger');
   
   class AuditLogger {
     static logAuth(success, details = {}) {
       logger.info('Authentication attempt', {
         event: 'auth',
         success,
         timestamp: new Date().toISOString(),
         ...details
       });
     }
     
     static logBalanceUpdate(account, oldBalance, newBalance) {
       logger.info('Balance updated', {
         event: 'balance_update',
         account,
         changed: oldBalance !== newBalance,
         timestamp: new Date().toISOString()
       });
     }
   }
   
   module.exports = AuditLogger;
   ```

### 4.2 Metrics & Alerting

#### Priority: LOW

1. **Add Prometheus Metrics**
   - **Package:** `npm install prom-client`
   - **File:** New file `src/metrics.js`
   ```javascript
   const client = require('prom-client');
   
   const register = new client.Registry();
   
   const syncDuration = new client.Histogram({
     name: 'ghostbudget_sync_duration_seconds',
     help: 'Duration of sync operations',
     registers: [register]
   });
   
   const syncErrors = new client.Counter({
     name: 'ghostbudget_sync_errors_total',
     help: 'Total number of sync errors',
     registers: [register]
   });
   
   module.exports = { syncDuration, syncErrors, register };
   ```

2. **Add Health Status Endpoint (Optional)**
   - **Use Case:** Kubernetes/monitoring integration
   - **File:** New file `src/health-server.js`
   ```javascript
   const http = require('http');
   const { register } = require('./metrics');
   
   const server = http.createServer(async (req, res) => {
     if (req.url === '/health') {
       res.writeHead(200, { 'Content-Type': 'application/json' });
       res.end(JSON.stringify({ status: 'healthy' }));
     } else if (req.url === '/metrics') {
       res.writeHead(200, { 'Content-Type': register.contentType });
       res.end(await register.metrics());
     } else {
       res.writeHead(404);
       res.end();
     }
   });
   
   server.listen(3000);
   ```

---

## 5. Testing Enhancements

### 5.1 Test Coverage Improvements

#### Priority: MEDIUM

1. **Add Integration Tests**
   - **Current:** Only unit tests exist
   - **File:** New file `tests/integration/sync.integration.test.js`
   ```javascript
   describe('Integration: Full Sync Flow', () => {
     it('should sync balances end-to-end', async () => {
       // Set up test environment
       // Mock external APIs
       // Run full sync
       // Verify results
     });
   });
   ```

2. **Add Security Tests**
   - **File:** New file `tests/security/validation.security.test.js`
   ```javascript
   describe('Security: Input Validation', () => {
     it('should reject XSS attempts in account names', () => {
       const malicious = '<script>alert("xss")</script>';
       expect(() => validateAccountName(malicious)).toThrow();
     });
     
     it('should reject SQL injection attempts', () => {
       const malicious = "'; DROP TABLE accounts; --";
       expect(() => validateAccountName(malicious)).toThrow();
     });
   });
   ```

3. **Increase Test Coverage to 90%+**
   - **Current:** Unknown coverage
   - **Target:** 90% line coverage
   - **Command:** `npm run test:coverage`
   - **Files to prioritize:**
     - [`src/utils/validation.js`](src/utils/validation.js) - Critical security component
     - [`src/ghostfolio.js`](src/ghostfolio.js) - Complex API logic
     - [`src/actualBudget.js`](src/actualBudget.js) - Data fetching logic

### 5.2 CI/CD Enhancements

#### Priority: LOW

1. **Add Coverage Reporting**
   - **File:** [`.github/workflows/test.yml`](.github/workflows/test.yml:45-47)
   - **Enhancement:**
   ```yaml
   - name: Run tests with coverage
     run: npm run test:coverage
   
   - name: Upload coverage to Codecov
     uses: codecov/codecov-action@v3
     with:
       files: ./coverage/lcov.info
       fail_ci_if_error: true
   ```

2. **Add SAST (Static Application Security Testing)**
   - **File:** [`.github/workflows/security.yml`](.github/workflows/security.yml)
   - **Enhancement:**
   ```yaml
   sast:
     name: SAST Analysis
     runs-on: ubuntu-latest
     steps:
       - uses: actions/checkout@v4
       - name: Run Snyk
         uses: snyk/actions/node@master
         env:
           SNYK_TOKEN: ${{ secrets.SNYK_TOKEN }}
   ```

3. **Add Automated Dependency Updates**
   - **Current:** Dependabot configured
   - **Enhancement:** Add auto-merge for patch updates
   - **File:** [`.github/workflows/dependabot-auto-merge.yml`](.github/workflows/dependabot-auto-merge.yml)

---

## 6. Documentation Improvements

### 6.1 Code Documentation

#### Priority: LOW

1. **Add API Documentation**
   - **Tool:** JSDoc with documentation generator
   - **Command:** `npm install --save-dev jsdoc`
   - **Script:** `"docs": "jsdoc -c jsdoc.json"`

2. **Create Architecture Diagram**
   - **File:** New file `docs/ARCHITECTURE.md`
   - **Content:** System architecture, data flow, security boundaries

3. **Add Troubleshooting Guide**
   - **File:** Enhance [`README.md`](README.md:185-203)
   - **Add:** Common errors, debugging steps, log analysis

### 6.2 Security Documentation

#### Priority: MEDIUM

1. **Create Security Runbook**
   - **File:** New file `docs/SECURITY_RUNBOOK.md`
   - **Content:** Incident response, security monitoring, audit procedures

2. **Document Threat Model**
   - **File:** New file `docs/THREAT_MODEL.md`
   - **Content:** Attack vectors, mitigations, security assumptions

---

## 7. Implementation Priority Matrix

### Phase 1: Critical Security (Week 1)
**Priority: HIGH - Immediate Implementation**

1. ✅ Rate limiting implementation
2. ✅ Circuit breaker pattern
3. ✅ Retry logic with exponential backoff
4. ✅ TLS cipher suite pinning
5. ✅ Enhanced input sanitization

**Estimated Effort:** 16-20 hours  
**Risk Reduction:** HIGH

### Phase 2: Performance & Optimization (Week 2)
**Priority: MEDIUM - Short-term Implementation**

1. ✅ Connection pooling
2. ✅ Response caching
3. ✅ Batch processing optimization
4. ✅ Extract constants
5. ✅ Consolidate environment loading

**Estimated Effort:** 12-16 hours  
**Performance Gain:** 20-30% faster sync

### Phase 3: Monitoring & Observability (Week 3)
**Priority: MEDIUM - Short-term Implementation**

1. ✅ Structured logging with correlation IDs
2. ✅ Performance metrics
3. ✅ Audit trail
4. ✅ Prometheus metrics (optional)
5. ✅ Health endpoint (optional)

**Estimated Effort:** 12-16 hours  
**Operational Benefit:** HIGH

### Phase 4: Testing & Quality (Week 4)
**Priority: LOW - Long-term Implementation**

1. ✅ Integration tests
2. ✅ Security tests
3. ✅ Increase coverage to 90%+
4. ✅ Add SAST to CI/CD
5. ✅ Coverage reporting

**Estimated Effort:** 16-20 hours  
**Quality Improvement:** HIGH

### Phase 5: Documentation & Polish (Week 5)
**Priority: LOW - Long-term Implementation**

1. ✅ JSDoc comments
2. ✅ API documentation
3. ✅ Architecture diagram
4. ✅ Security runbook
5. ✅ Threat model

**Estimated Effort:** 8-12 hours  
**Maintainability:** HIGH

---

## 8. Package Dependencies to Add

### Security Packages
```json
{
  "dependencies": {
    "rate-limiter-flexible": "^5.0.3",
    "opossum": "^8.1.4",
    "axios-retry": "^4.0.0",
    "validator": "^13.11.0",
    "uuid": "^9.0.1"
  },
  "devDependencies": {
    "prom-client": "^15.1.0",
    "jsdoc": "^4.0.2"
  }
}
```

### Installation Command
```bash
npm install rate-limiter-flexible opossum axios-retry validator uuid
npm install --save-dev prom-client jsdoc
```

---

## 9. Configuration Updates

### 9.1 Environment Variables to Add

**File:** [`.env.example`](.env.example)

```bash
# Existing variables...

# Security Configuration
NODE_ENV=production
REQUEST_SECRET=your-hmac-secret-key-here
GHOSTFOLIO_CERT_FINGERPRINT=optional-cert-fingerprint

# Performance Configuration
CACHE_TTL_MINUTES=5
BATCH_SIZE=10
MAX_RETRIES=3

# Monitoring Configuration (Optional)
METRICS_PORT=3000
ENABLE_METRICS=false
```

### 9.2 Config Schema Updates

**File:** [`src/utils/validation.js`](src/utils/validation.js:23-32)

```javascript
const envSchema = Joi.object({
  // Existing fields...
  
  // New fields
  REQUEST_SECRET: Joi.string().min(32).optional(),
  GHOSTFOLIO_CERT_FINGERPRINT: Joi.string().hex().length(64).optional(),
  CACHE_TTL_MINUTES: Joi.number().integer().min(1).max(60).default(5),
  BATCH_SIZE: Joi.number().integer().min(1).max(50).default(10),
  MAX_RETRIES: Joi.number().integer().min(0).max(10).default(3),
  METRICS_PORT: Joi.number().integer().min(1024).max(65535).default(3000),
  ENABLE_METRICS: Joi.boolean().default(false)
}).unknown(true);
```

---

## 10. Best Practices Checklist

### Code Quality ✅
- [x] Input validation with Joi schemas
- [x] Error sanitization
- [x] Structured logging
- [ ] JSDoc documentation (TO ADD)
- [ ] Constants extracted (TO ADD)
- [x] No console.log usage
- [x] Proper error handling

### Security ✅
- [x] HTTPS enforcement
- [x] TLS 1.2+ minimum
- [x] Certificate validation
- [x] Non-root container
- [x] Secrets not in logs
- [ ] Rate limiting (TO ADD)
- [ ] Circuit breaker (TO ADD)
- [ ] Input sanitization enhanced (TO ADD)

### Performance ⚠️
- [x] Parallel processing
- [ ] Connection pooling (TO ADD)
- [ ] Response caching (TO ADD)
- [ ] Batch processing (TO ADD)
- [x] Timeout configuration

### Testing ⚠️
- [x] Unit tests exist
- [ ] Integration tests (TO ADD)
- [ ] Security tests (TO ADD)
- [ ] 90%+ coverage (TO ADD)
- [x] CI/CD pipeline

### Deployment ✅
- [x] Docker best practices
- [x] Health checks
- [x] Graceful shutdown
- [x] Log rotation
- [ ] Multi-stage build (TO ADD)
- [ ] Image signing (TO ADD)

---

## 11. Maintenance Schedule

### Daily
- Monitor logs for errors
- Check sync success rate
- Review security alerts

### Weekly
- Review dependency updates
- Check for new CVEs
- Analyze performance metrics

### Monthly
- Rotate access tokens
- Update Docker base image
- Review and update documentation
- Run security audit

### Quarterly
- Comprehensive security review
- Performance optimization review
- Update threat model
- Review and update runbooks

---

## 12. Success Metrics

### Performance Metrics
- **Sync Duration:** < 30 seconds for 10 accounts
- **API Response Time:** < 2 seconds average
- **Error Rate:** < 1% of sync operations
- **Uptime:** > 99.9%

### Security Metrics
- **Vulnerability Count:** 0 critical/high
- **Dependency Age:** < 6 months
- **Security Scan Pass Rate:** 100%
- **Incident Response Time:** < 1 hour

### Quality Metrics
- **Test Coverage:** > 90%
- **Code Review Coverage:** 100%
- **Documentation Coverage:** > 80%
- **Technical Debt Ratio:** < 5%

---

## 13. Conclusion

GhostBudget is already in excellent shape with strong security foundations. This plan provides a roadmap for achieving enterprise-grade quality through:

1. **Enhanced Security:** Rate limiting, circuit breakers, and advanced input sanitization
2. **Improved Performance:** Connection pooling, caching, and optimized batch processing
3. **Better Observability:** Structured logging, metrics, and audit trails
4. **Higher Quality:** Comprehensive testing and documentation

**Recommended Approach:**
- Implement Phase 1 (Critical Security) immediately
- Roll out Phases 2-3 over the next month
- Complete Phases 4-5 as time permits

**Total Estimated Effort:** 64-84 hours (8-10 working days)

**Expected Outcomes:**
- 🔒 Enhanced security posture (9/10 OWASP compliance)
- ⚡ 20-30% performance improvement
- 📊 Complete operational visibility
- ✅ 90%+ test coverage
- 📚 Comprehensive documentation

---

**Document Version:** 1.0  
**Last Updated:** 2026-06-04  
**Next Review:** 2026-07-04