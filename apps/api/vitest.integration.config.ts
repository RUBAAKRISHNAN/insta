import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  test: {
    include: ['src/**/*.integration.test.ts'],
    maxWorkers: 1,
    setupFiles: [
      fileURLToPath(
        new URL('./scripts/integration-test-safety.mjs', import.meta.url),
      ),
    ],
  },
});
