#!/usr/bin/env node
'use strict';

/**
 * Exports the OpenAPI spec from backend/src/openapi.js to openapi.json at the
 * repository root. Run after any change to the spec:
 *
 *   node backend/scripts/export-openapi.js
 *
 * The generated file is committed to the repository so that:
 *   - GitHub renders a link-able, browsable version of the spec
 *   - Tools like openapi-generator-cli can consume it without a running server
 *   - The spec can be hosted on Redocly, Bump.sh, or similar with zero config
 */

const path = require('path');
const fs = require('fs');

const spec = require('../src/openapi');
const outPath = path.join(__dirname, '..', '..', 'openapi.json');

fs.writeFileSync(outPath, JSON.stringify(spec, null, 2) + '\n');
console.log(`Wrote ${outPath}`);
