const winston = require('winston');
const { v4: uuidv4 } = require('uuid');
const constants = require('./config/constants');

// Generate correlation ID for this process instance
const correlationId = uuidv4();

// Create a null transport that does nothing
const nullTransport = new winston.transports.Console({
  silent: true,
});

// Create normal transports for non-test environment
const normalTransports = [
  // Write all logs to console
  new winston.transports.Console({
    format: winston.format.combine(winston.format.colorize(), winston.format.simple()),
  }),
  // Write all logs with level 'info' and below to combined.log
  new winston.transports.File({
    filename: 'logs/combined.log',
    maxsize: constants.LOG_MAX_SIZE_BYTES,
    maxFiles: constants.LOG_MAX_FILES,
  }),
  // Write all errors to error.log
  new winston.transports.File({
    filename: 'logs/error.log',
    level: 'error',
    maxsize: constants.LOG_MAX_SIZE_BYTES,
    maxFiles: constants.LOG_MAX_FILES,
  }),
];

// Choose transports based on environment
const transports = process.env.NODE_ENV === 'test' ? [nullTransport] : normalTransports;

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
