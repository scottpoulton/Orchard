'use strict';

const { spawnSync } = require('child_process');
const path = require('path');

const serverDir = path.join(__dirname, '..', 'packages', 'server');
const npxCmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const env = {
  ...process.env,
  DATABASE_URL: process.env.DATABASE_URL || 'file:./prisma/dev.db',
};

function runPrisma(args) {
  const result = spawnSync(npxCmd, ['prisma', ...args], {
    cwd: serverDir,
    stdio: 'inherit',
    env,
  });
  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

const args = new Set(process.argv.slice(2));
const runGenerate = args.has('--generate-only') || !args.has('--migrate-only');
const runMigrate = args.has('--migrate-only') || !args.has('--generate-only');

if (runGenerate) {
  runPrisma(['generate']);
}
if (runMigrate) {
  runPrisma(['migrate', 'deploy']);
}
