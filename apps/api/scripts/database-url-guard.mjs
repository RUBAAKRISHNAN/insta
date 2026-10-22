export const INTEGRATION_DATABASE_NAME = 'lumen_social_test';

export function validateIntegrationDatabaseUrl(databaseUrl) {
  if (typeof databaseUrl !== 'string' || databaseUrl.length === 0) {
    throw new Error('DATABASE_URL is required for API integration tests.');
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(databaseUrl);
  } catch {
    throw new Error('DATABASE_URL must be a valid PostgreSQL URL for API integration tests.');
  }

  if (
    parsedUrl.protocol !== 'postgresql:' ||
    parsedUrl.hostname.length === 0 ||
    parsedUrl.hash.length > 0 ||
    [...parsedUrl.searchParams.keys()].some((key) =>
      ['database', 'dbname'].includes(key.toLowerCase()),
    )
  ) {
    throw new Error('DATABASE_URL must be a valid PostgreSQL URL for API integration tests.');
  }

  let databaseName;
  try {
    databaseName = decodeURIComponent(parsedUrl.pathname.slice(1));
  } catch {
    throw new Error('DATABASE_URL must be a valid PostgreSQL URL for API integration tests.');
  }

  if (databaseName !== INTEGRATION_DATABASE_NAME) {
    throw new Error(
      `API integration tests are restricted to the "${INTEGRATION_DATABASE_NAME}" database.`,
    );
  }
}
