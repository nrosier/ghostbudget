const fs = require('fs');
const path = require('path');
const winston = require('winston');
const { v4: uuidv4 } = require('uuid');
const constants = require('./config/constants');

// Generate correlation ID for this process instance
const correlationId = uuidv4();

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
  defaultMeta: { service: 'ghostbudget', version: '1.0.0' },
  transports: transports,
});

module.exports = logger;
