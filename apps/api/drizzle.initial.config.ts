import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './dist/db/schema/index.js',
  out: './drizzle-initial',
  dialect: 'postgresql',
  strict: true,
  verbose: true,
});
