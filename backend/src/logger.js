'use strict';

const pino = require('pino');

/**
 * Singleton pino logger.  All modules should create a child logger:
 *
 *   const log = require('../logger').child({ module: 'MyModule' });
 *
 * Log level is controlled by the LOG_LEVEL environment variable (default: info).
 * To pretty-print during local development, pipe output through pino-pretty:
 *
 *   npm run dev | npx pino-pretty
 */
module.exports = pino({ level: process.env.LOG_LEVEL || 'info' });
