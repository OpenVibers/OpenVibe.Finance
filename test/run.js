/**
 * Runs every *.test.js in test/ (openvibe-shared/test-runner), each in its own process with a database of its own.
 */
'use strict';
require('openvibe-shared/test-runner').main({ dir: __dirname, timeoutMs: 60000, pad: 28, ...(process.env.FINANCE_TEST_STORE === 'pg' ? { parallel: 1 } : {}) });
