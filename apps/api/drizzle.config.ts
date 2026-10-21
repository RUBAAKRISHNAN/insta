import { defineConfig } from 'drizzle-kit';
import 'dotenv/config';

export default defineConfig({
  schema: './src/db/schema/index.ts',
  // Fresh development-only lineage generated from the complete current schema.
  // The orphaned hand-authored SQL remains in ./drizzle for reference only.
  out: './drizzle-v2',
  dialect: 'postgresql',
  dbCredentials: { url: process.env.DATABASE_URL ?? '' },
  strict: true,
  verbose: true,
});
