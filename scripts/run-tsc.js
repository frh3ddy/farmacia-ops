#!/usr/bin/env node

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

// Try to find TypeScript in various locations
const possiblePaths = [
  path.resolve(__dirname, '../node_modules/typescript/bin/tsc'),
  path.resolve(__dirname, '../node_modules/.bin/tsc'),
  path.resolve(process.cwd(), 'node_modules/typescript/bin/tsc'),
  path.resolve(process.cwd(), 'node_modules/.bin/tsc'),
];

let tscPath = null;
for (const tsc of possiblePaths) {
  if (fs.existsSync(tsc)) {
    tscPath = tsc;
    break;
  }
}

if (!tscPath) {
  // Try to resolve via require
  try {
    const typescriptPath = require.resolve('typescript');
    tscPath = path.join(path.dirname(typescriptPath), '../bin/tsc');
    if (!fs.existsSync(tscPath)) {
      throw new Error('tsc not found');
    }
  } catch (e) {
    console.error('Error: TypeScript compiler (tsc) not found.');
    console.error('Make sure TypeScript is installed: npm install typescript');
    process.exit(1);
  }
}

// Run tsc with all arguments passed to this script
try {
  execSync(`node "${tscPath}" ${process.argv.slice(2).join(' ')}`, {
    stdio: 'inherit',
    cwd: process.cwd(),
  });
} catch (error) {
  process.exit(error.status || 1);
}

