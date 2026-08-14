/**
 * Process-wide TLS floor.
 *
 * Requiring this module sets the minimum protocol version for *every* TLS connection
 * the process makes, whoever opens it. That matters because the hardened `https.Agent`
 * in [src/ghostfolio.js] only covers the Ghostfolio leg of the egress —
 * `@actual-app/api` opens its own connections and never sees that agent.
 * `tls.DEFAULT_MIN_VERSION` is the value Node uses whenever a caller does not pass
 * `minVersion`, so it reaches axios, undici/fetch, and the Actual Budget client alike.
 *
 * Node's own default is already TLSv1.2, so this pins the floor rather than raising it:
 * the point is that it can no longer drift with a Node upgrade or a dependency that
 * builds its own agent. See docs/decisions.md.
 */

const tls = require('tls');
const constants = require('./constants');

tls.DEFAULT_MIN_VERSION = constants.TLS_MIN_VERSION;

module.exports = { minVersion: tls.DEFAULT_MIN_VERSION };
