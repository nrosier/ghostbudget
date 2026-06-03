# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 1.0.x   | :white_check_mark: |

## Security Best Practices

### Deployment

1. **Always use HTTPS** for both Actual Budget and Ghostfolio URLs in production
2. **Never commit secrets** to version control
3. **Use Docker secrets** or external secret managers (Vault, AWS Secrets Manager) instead of environment variables
4. **Run containers as non-root** (already configured in Dockerfile)
5. **Keep dependencies updated** regularly with `npm audit` and `npm update`
6. **Use specific version tags** for Docker images, not `latest`

### Configuration

1. **Validate all configuration** before deployment
2. **Use strong passwords** for Actual Budget (minimum 16 characters)
3. **Rotate access tokens** regularly (at least every 90 days)
4. **Limit token permissions** to minimum required scope
5. **Use read-only volumes** where possible in Docker

### Monitoring

1. **Monitor logs** for authentication failures
2. **Set up alerts** for repeated sync failures
3. **Review audit logs** regularly
4. **Track API rate limits** to avoid service disruption

### Network Security

1. **Use private networks** for container communication
2. **Implement firewall rules** to restrict access
3. **Enable TLS 1.2+** for all connections
4. **Validate SSL certificates** (enforced by default)

## Reporting a Vulnerability

If you discover a security vulnerability, please follow these steps:

1. **DO NOT** open a public issue
2. Email the maintainers directly with:
   - Description of the vulnerability
   - Steps to reproduce
   - Potential impact
   - Suggested fix (if any)

3. Allow up to 48 hours for initial response
4. Work with maintainers on coordinated disclosure

## Security Features

### Implemented

- ✅ Input validation with Joi schema validation
- ✅ Sanitized error logging (no stack traces or secrets)
- ✅ HTTPS enforcement with certificate validation
- ✅ Non-root container execution
- ✅ Secure dependency management (pinned versions)
- ✅ Request timeouts and size limits
- ✅ Graceful shutdown handling
- ✅ Environment variable validation
- ✅ TLS 1.2+ enforcement

### Planned

- 🔄 Rate limiting and circuit breakers
- 🔄 Token expiration and refresh
- 🔄 Audit logging for security events
- 🔄 Metrics and monitoring integration
- 🔄 SAST in CI/CD pipeline
- 🔄 Dependency vulnerability scanning
- 🔄 Container image signing

## Security Checklist for Deployment

Before deploying to production, ensure:

- [ ] All secrets are stored securely (not in .env files)
- [ ] HTTPS is enforced for all API endpoints
- [ ] Docker image is built from pinned base image
- [ ] Container runs as non-root user
- [ ] Logs are monitored and aggregated
- [ ] Backups are configured and tested
- [ ] Access tokens have been rotated
- [ ] Network policies restrict container access
- [ ] Health checks are configured
- [ ] Resource limits are set (CPU, memory)
- [ ] Dependencies have been audited (`npm audit`)
- [ ] Configuration has been validated

## Known Security Considerations

### Secrets in Environment Variables

While environment variables are used for configuration, be aware:
- They are visible in `docker inspect` (use Docker secrets instead)
- They may appear in process listings
- They are inherited by child processes

**Mitigation:** Use Docker secrets or external secret managers in production.

### API Token Storage

Access tokens are stored in memory during execution:
- Tokens are cleared on process exit
- No tokens are written to disk
- Tokens are not logged

**Best Practice:** Rotate tokens regularly and use short-lived tokens where possible.

### Logging

Logs may contain:
- Account names (not considered sensitive)
- Sync status and errors
- API endpoint URLs

Logs do NOT contain:
- Passwords or access tokens
- Account balances (in production mode)
- Stack traces (sanitized)
- Full error objects

## Compliance

This application follows:
- OWASP Top 10 security guidelines
- Docker security best practices
- Node.js security best practices
- OpenSSF security guidelines

## Security Updates

Security updates are released as soon as possible after discovery. Subscribe to repository notifications to stay informed.

## Additional Resources

- [OWASP Top 10](https://owasp.org/Top10/)
- [Docker Security Best Practices](https://docs.docker.com/develop/security-best-practices/)
- [Node.js Security Best Practices](https://nodejs.org/en/docs/guides/security/)
- [npm Security Best Practices](https://docs.npmjs.com/security-best-practices)