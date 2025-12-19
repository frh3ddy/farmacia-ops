#!/usr/bin/env node

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

// Get the root directory (where scripts/ folder is)
const rootDir = path.resolve(__dirname, '..');

// Try to find TypeScript using require.resolve (works with npm workspaces)
let tscPath;
try {
  // This will find TypeScript in the workspace's node_modules
  const typescriptPath = require.resolve('typescript');
  tscPath = path.join(path.dirname(typescriptPath), 'bin/tsc');
  
  if (!fs.existsSync(tscPath)) {
    throw new Error('tsc binary not found at resolved path');
  }
} catch (e) {
  // Fallback: try common locations
  const possiblePaths = [
    path.join(rootDir, 'node_modules/typescript/bin/tsc'),
    path.join(rootDir, 'node_modules/.bin/tsc'),
    path.join(process.cwd(), 'node_modules/typescript/bin/tsc'),
    path.join(process.cwd(), 'node_modules/.bin/tsc'),
  ];
  
  tscPath = possiblePaths.find(p => fs.existsSync(p));
  
  if (!tscPath) {
    console.error('Error: TypeScript compiler (tsc) not found.');
    console.error('Make sure TypeScript is installed: npm install typescript');
    process.exit(1);
  }
}

// Run tsc with all arguments passed to this script
try {
  const args = process.argv.slice(2).join(' ');
  execSync(`node "${tscPath}" ${args}`, {
    stdio: 'inherit',
    cwd: process.cwd(),
    env: process.env,
  });
} catch (error) {
  process.exit(error.status || 1);
}

