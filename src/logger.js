const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const winston = require('winston');
const constants = require('./config/constants');
const build = require('./config/version');

// Correlation ID for this process instance. Node's own randomUUID rather than the
// `uuid` package: it is the same v4 UUID from the same CSPRNG, with one fewer
// dependency to install, audit and mock around in Jest — `uuid` ships as ESM and
// needed a transformIgnorePatterns entry and a global mock to work here at all.
const correlationId = crypto.randomUUID();

// Create a null transport that does nothing
const nullTransport = new winston.transports.Console({
  silent: true,
});

const consoleTransport = new winston.transports.Console({
  format: winston.format.combine(winston.format.colorize(), winston.format.simple()),
});

/**
 * Build the file transports, creating the log directory if it is missing.
 *
 * Winston does not create the directory itself: it emits an ENOENT on the
 * transport and drops the write. Console logging must survive that, because a
 * container with a read-only root filesystem and no logs volume is a
 * misconfiguration to report — not a reason to lose every message about it.
 *
 * @returns {Array<Object>} File transports, or an empty array if the directory is unusable
 */
function buildFileTransports() {
  const dir = constants.logDir();

  try {
    // The path comes from constants.logDir(): the app root, or a GHOSTBUDGET_LOG_DIR
    // set by the operator.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    fs.mkdirSync(dir, { recursive: true, mode: 0o750 });
  } catch (error) {
    // The logger itself does not exist yet, so this is the one place a bare
    // console write is the only option available.
    console.warn(
      `File logging disabled: cannot create log directory ${dir} ` +
        `(${error.code || error.message}). Logs will go to the console only.`
    );
    return [];
  }

  return [
    // Write all logs with level 'info' and below to combined.log
    new winston.transports.File({
      filename: path.join(dir, 'combined.log'),
      maxsize: constants.LOG_MAX_SIZE_BYTES,
      maxFiles: constants.LOG_MAX_FILES,
    }),
    // Write all errors to error.log
    new winston.transports.File({
      filename: path.join(dir, 'error.log'),
      level: 'error',
      maxsize: constants.LOG_MAX_SIZE_BYTES,
      maxFiles: constants.LOG_MAX_FILES,
    }),
  ];
}

// Choose transports based on environment
const transports =
  process.env.NODE_ENV === 'test' ? [nullTransport] : [consoleTransport, ...buildFileTransports()];

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format((info) => {
      // Add correlation ID to all logs (service/version come from defaultMeta)
      info.correlationId = correlationId;
      return info;
    })(),
    winston.format.json()
  ),
  // Version and commit on every record, from package.json and the build stamp rather
  // than a literal here — see src/config/version.js for the format and why the build
  // time is not among them.
  defaultMeta: { service: 'ghostbudget', ...build.meta },
  transports: transports,
});

module.exports = logger;
