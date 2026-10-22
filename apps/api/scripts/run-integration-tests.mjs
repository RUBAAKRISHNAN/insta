import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateIntegrationDatabaseUrl } from './database-url-guard.mjs';

try {
  validateIntegrationDatabaseUrl(process.env.DATABASE_URL);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

const require = createRequire(import.meta.url);
const vitestPackagePath = require.resolve('vitest/package.json');
const vitestCliPath = join(dirname(vitestPackagePath), 'vitest.mjs');
const integrationConfigPath = fileURLToPath(
  new URL('../vitest.integration.config.ts', import.meta.url),
);
const result = spawnSync(
  process.execPath,
  [vitestCliPath, 'run', '--config', integrationConfigPath],
  {
    stdio: 'inherit',
    env: process.env,
  },
);

if (result.error) {
  console.error('Unable to start API integration tests.');
  process.exit(1);
}

process.exit(result.status ?? 1);
