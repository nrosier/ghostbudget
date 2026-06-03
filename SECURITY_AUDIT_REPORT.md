# Security Audit Report - GhostBudget
**Date:** 2026-06-03  
**Auditor:** Bob (Security Review)

## Executive Summary

This security audit identified **CRITICAL** and **HIGH** severity vulnerabilities in the GhostBudget project. While dependencies are up-to-date with no known CVEs, the codebase has significant security gaps that must be addressed before production deployment.

**Overall Risk Level:** 🔴 **HIGH**

---

## Critical Findings

### 1. 🔴 CRITICAL: Secrets Exposed in Logs and Error Messages
**Location:** `src/actualBudget.js`, `src/ghostfolio.js`, `src/index.js`

**Issue:**
- Stack traces logged with `error.stack` may expose sensitive data
- Error messages in logs could leak credentials or tokens
- No sanitization of error objects before logging

**Impact:** Credential exposure, unauthorized access

**Recommendation:**
```javascript
// NEVER log full error objects or stacks in production
logger.error('Operation failed', { 
  message: error.message,
  code: error.code 
  // DO NOT include: stack, error object, or sensitive context
});
```

---

### 2. 🔴 CRITICAL: Insecure Secrets Management in Dockerfile
**Location:** `Dockerfile`, `entrypoint.sh`

**Issues:**
- Secrets passed as environment variables are visible in `docker inspect`
- `entrypoint.sh` writes ALL environment variables to `/app/project_env.sh` (line 2)
- Secrets stored in plaintext in container filesystem
- No secret rotation mechanism

**Impact:** Full credential compromise if container is accessed

**Recommendation:**
- Use Docker secrets or external secret managers (Vault, AWS Secrets Manager)
- Never write secrets to files
- Implement secret rotation

---

### 3. 🔴 CRITICAL: No Input Validation
**Location:** `src/ghostfolio.js`, `src/actualBudget.js`

**Issues:**
- No validation of `config.json` structure or content
- No validation of API responses before processing
- `mapping.factor` validation is insufficient (line 142-146)
- No sanitization of account names or balances

**Impact:** 
- Injection attacks via malicious config
- Type confusion vulnerabilities
- Potential for prototype pollution

**Recommendation:**
```javascript
// Implement schema validation
const Joi = require('joi');

const configSchema = Joi.object({
  accounts: Joi.array().items(
    Joi.object({
      ghostfolioName: Joi.string().trim().max(255).required(),
      actualBudgetName: Joi.string().trim().max(255).required(),
      factor: Joi.number().positive().default(1)
    })
  ).min(1).required()
});

// Validate before use
const { error, value } = configSchema.validate(config);
if (error) throw new Error(`Invalid config: ${error.message}`);
```

---

## High Severity Findings

### 4. 🟠 HIGH: Missing Authentication Security Controls
**Location:** `src/ghostfolio.js`

**Issues:**
- No token expiration handling
- No token refresh mechanism
- No rate limiting on API calls
- Bearer token stored in memory without protection
- No session timeout

**Recommendation:**
- Implement token expiration checks
- Add retry logic with exponential backoff
- Implement rate limiting
- Clear tokens from memory after use

---

### 5. 🟠 HIGH: Insufficient Error Handling
**Location:** Multiple files

**Issues:**
- `process.exit(1)` terminates without cleanup (index.js:15, 27)
- No graceful shutdown handling
- Partial sync failures not properly handled
- No transaction rollback mechanism

**Recommendation:**
```javascript
// Implement graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, shutting down gracefully');
  await cleanup();
  process.exit(0);
});

// Use proper error boundaries
try {
  await operation();
} catch (error) {
  await rollback();
  throw error;
} finally {
  await cleanup();
}
```

---

### 6. 🟠 HIGH: Insecure Dockerfile Configuration
**Location:** `Dockerfile`

**Issues:**
- Running as root user (no USER directive)
- No security scanning in build process
- Base image not pinned to specific digest
- `npm update` in Dockerfile (line 6) is unpredictable
- No health checks defined
- Unnecessary bash installation

**Current:**
```dockerfile
FROM node:lts-alpine
RUN apk add --no-cache bash
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
RUN npm update  # ❌ DANGEROUS
```

**Recommended:**
```dockerfile
FROM node:22.14.0-alpine3.21@sha256:... # Pin to digest
RUN addgroup -g 1001 -S nodejs && adduser -S nodejs -u 1001
WORKDIR /app
COPY --chown=nodejs:nodejs package*.json ./
RUN npm ci --omit=dev --ignore-scripts && \
    npm cache clean --force
COPY --chown=nodejs:nodejs . .
USER nodejs
HEALTHCHECK --interval=30s --timeout=3s \
  CMD node -e "process.exit(0)" || exit 1
ENTRYPOINT ["/app/entrypoint.sh"]
```

---

### 7. 🟠 HIGH: Missing Security Headers and HTTPS Enforcement
**Location:** API calls in `src/ghostfolio.js`

**Issues:**
- No HTTPS enforcement
- No certificate validation configuration
- No timeout configuration on HTTP requests
- No request size limits

**Recommendation:**
```javascript
const axios = require('axios');
const https = require('https');

const axiosInstance = axios.create({
  timeout: 30000,
  maxContentLength: 10 * 1024 * 1024, // 10MB
  maxBodyLength: 10 * 1024 * 1024,
  httpsAgent: new https.Agent({
    rejectUnauthorized: true, // Enforce cert validation
    minVersion: 'TLSv1.2'
  })
});

// Validate URLs are HTTPS
if (!url.startsWith('https://')) {
  throw new Error('Only HTTPS URLs are allowed');
}
```

---

## Medium Severity Findings

### 8. 🟡 MEDIUM: Insufficient Logging Security
**Location:** `src/logger.js`

**Issues:**
- No log rotation size limits enforced at runtime
- Logs may contain sensitive data (balances, account names)
- No structured logging for security events
- No audit trail for authentication events

**Recommendation:**
- Implement PII masking in logs
- Add security event logging (auth attempts, failures)
- Use correlation IDs for request tracking
- Implement log aggregation and monitoring

---

### 9. 🟡 MEDIUM: Missing Rate Limiting and Circuit Breakers
**Location:** API calls throughout

**Issues:**
- No protection against API rate limits
- No circuit breaker pattern
- Could cause service degradation or bans

**Recommendation:**
```javascript
const CircuitBreaker = require('opossum');

const breaker = new CircuitBreaker(apiCall, {
  timeout: 30000,
  errorThresholdPercentage: 50,
  resetTimeout: 30000
});
```

---

### 10. 🟡 MEDIUM: Insecure Cron Configuration
**Location:** `entrypoint.sh`

**Issues:**
- Cron runs as root
- No validation of CRON_TASK input
- Potential command injection via CRON_TASK variable
- No logging of cron execution failures

**Recommendation:**
```bash
#!/bin/sh
# Validate CRON_TASK format
if ! echo "$CRON_TASK" | grep -qE '^[0-9\*\-\,\/\s]+$'; then
  echo "Invalid CRON_TASK format"
  exit 1
fi

# Run as non-root user
su -s /bin/sh nodejs -c "crontab -"
```

---

## Dependency Analysis

### Current Versions (All Up-to-Date ✅)
- `@actual-app/api`: 26.6.0 (latest)
- `axios`: 1.17.0 (latest)
- `dotenv`: 17.4.2 (latest)
- `winston`: 3.19.0 (latest)

### npm audit: ✅ No known vulnerabilities

**However:** Version ranges in package.json allow automatic updates that could introduce vulnerabilities.

---

## Missing Security Features

### 11. No Security Testing
- No SAST (Static Application Security Testing)
- No dependency scanning in CI/CD
- No security-focused unit tests
- No fuzzing or penetration testing

### 12. No Observability for Security
- No metrics for failed auth attempts
- No alerting on suspicious activity
- No distributed tracing
- No security dashboards

### 13. No Secure Development Practices
- No security.txt file
- No vulnerability disclosure policy
- No SBOM (Software Bill of Materials)
- No signed releases

---

## Compliance Gaps

### OWASP Top 10 (2021) Violations:
- ✅ A01:2021 – Broken Access Control: **PASS** (minimal access control needed)
- ❌ A02:2021 – Cryptographic Failures: **FAIL** (secrets in logs, plaintext storage)
- ❌ A03:2021 – Injection: **FAIL** (no input validation)
- ❌ A04:2021 – Insecure Design: **FAIL** (no security architecture)
- ❌ A05:2021 – Security Misconfiguration: **FAIL** (Docker runs as root)
- ❌ A06:2021 – Vulnerable Components: **PASS** (dependencies up-to-date)
- ❌ A07:2021 – Authentication Failures: **FAIL** (no token management)
- ❌ A08:2021 – Software and Data Integrity: **FAIL** (no signing, no SBOM)
- ❌ A09:2021 – Security Logging Failures: **FAIL** (sensitive data in logs)
- ❌ A10:2021 – SSRF: **PARTIAL** (URLs not validated)

**Score: 2/10 OWASP compliance** 🔴

---

## Immediate Action Items (Priority Order)

### 🔴 CRITICAL - Fix Immediately:
1. Remove all secrets from logs and error messages
2. Implement input validation with schema validation library
3. Fix Dockerfile to run as non-root user
4. Secure entrypoint.sh to prevent secret exposure
5. Pin all dependencies to exact versions

### 🟠 HIGH - Fix Before Production:
6. Implement proper token lifecycle management
7. Add HTTPS enforcement and certificate validation
8. Implement graceful shutdown and cleanup
9. Add rate limiting and circuit breakers
10. Implement comprehensive error handling

### 🟡 MEDIUM - Fix Soon:
11. Add security-focused logging and monitoring
12. Implement audit trail
13. Add health checks and readiness probes
14. Secure cron configuration
15. Add security testing to CI/CD

---

## Recommended Security Stack Additions

```json
{
  "dependencies": {
    "joi": "^17.13.3",           // Input validation
    "helmet": "^8.0.0",          // Security headers (if web server)
    "rate-limiter-flexible": "^5.0.3", // Rate limiting
    "opossum": "^8.1.4"          // Circuit breaker
  },
  "devDependencies": {
    "eslint-plugin-security": "^3.0.1",
    "snyk": "^1.1293.1",         // Vulnerability scanning
    "npm-audit-resolver": "^3.0.0-RC.0"
  }
}
```

---

## Conclusion

**Current State:** The application is **NOT PRODUCTION-READY** from a security perspective.

**Risk Assessment:**
- **Credential Exposure Risk:** CRITICAL
- **Injection Attack Risk:** HIGH  
- **Container Security Risk:** HIGH
- **Operational Security Risk:** MEDIUM

**Estimated Remediation Time:** 3-5 days for critical issues, 1-2 weeks for full hardening.

**Next Steps:**
1. Implement critical fixes immediately
2. Add comprehensive security testing
3. Conduct penetration testing
4. Implement security monitoring
5. Create incident response plan

---

## References
- OWASP Top 10: https://owasp.org/Top10/
- Docker Security Best Practices: https://docs.docker.com/develop/security-best-practices/
- Node.js Security Best Practices: https://nodejs.org/en/docs/guides/security/
- OpenSSF Best Practices: https://bestpractices.coreinfrastructure.org/