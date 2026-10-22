import { validateIntegrationDatabaseUrl } from './database-url-guard.mjs';

validateIntegrationDatabaseUrl(process.env.DATABASE_URL);
