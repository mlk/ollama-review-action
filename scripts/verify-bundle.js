#!/usr/bin/env node
'use strict';

// Checks that dist/index.js is a complete bundle.
//
// The bundler can fail to resolve a dependency without failing the build: it
// leaves a "Cannot find module" stub behind and the action then dies at run
// time with a confusing error. This catches that before it is shipped.

const fs = require('node:fs');
const path = require('node:path');

const bundle = path.join(__dirname, '..', 'dist', 'index.js');

if (!fs.existsSync(bundle)) {
  console.error('dist/index.js is missing. Run "npm run build" first.');
  process.exit(1);
}

const source = fs.readFileSync(bundle, 'utf8');
const problems = [];

if (source.includes('webpackMissingModule')) {
  problems.push('it contains a bundler "missing module" stub');
}

if (source.includes('Cannot find module')) {
  problems.push('it contains an unresolved require');
}

// Things the action cannot work without.
for (const needle of ['getInput', 'setOutput', 'chat/completions']) {
  if (!source.includes(needle)) {
    problems.push(`it does not contain "${needle}"`);
  }
}

if (problems.length > 0) {
  console.error('dist/index.js is not a complete bundle:');
  for (const problem of problems) {
    console.error(`  - ${problem}`);
  }
  console.error('');
  console.error('This usually means the bundler could not resolve a dependency.');
  process.exit(1);
}

console.log('dist/index.js is a complete bundle.');
