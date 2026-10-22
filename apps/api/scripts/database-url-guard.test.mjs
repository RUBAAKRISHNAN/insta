import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { validateIntegrationDatabaseUrl } from './database-url-guard.mjs';

function runIntegrationSafetyModule(databaseUrl) {
  const env = { ...process.env };
  delete env.DATABASE_URL;
  if (databaseUrl !== undefined) env.DATABASE_URL = databaseUrl;

  return spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import(${JSON.stringify(new URL('./integration-test-safety.mjs', import.meta.url).href)})`,
    ],
    { encoding: 'utf8', env },
  );
}

test('rejects a missing database URL', () => {
  assert.throws(
    () => validateIntegrationDatabaseUrl(undefined),
    /DATABASE_URL is required/,
  );
});

test('rejects a malformed database URL without echoing it', () => {
  const malformedUrl = 'postgresql://localhost:invalid/lumen_social_test';
  assert.throws(
    () => validateIntegrationDatabaseUrl(malformedUrl),
    (error) => {
      assert.match(error.message, /valid PostgreSQL URL/);
      assert.doesNotMatch(error.message, /secret-value/);
      return true;
    },
  );
});

test('rejects a non-PostgreSQL URL', () => {
  assert.throws(
    () =>
      validateIntegrationDatabaseUrl(
        'mysql://localhost:3306/lumen_social_test',
      ),
    /valid PostgreSQL URL/,
  );
});

test('rejects the development database', () => {
  assert.throws(
    () =>
      validateIntegrationDatabaseUrl(
        'postgresql://localhost:5432/lumen_social',
      ),
    /restricted to the "lumen_social_test" database/,
  );
});

test('rejects a production or other database name', () => {
  assert.throws(
    () =>
      validateIntegrationDatabaseUrl(
        'postgresql://db.example.invalid:5432/lumen_social_prod',
      ),
    /restricted to the "lumen_social_test" database/,
  );
});

test('rejects database-name overrides in URL parameters', () => {
  for (const parameter of ['database', 'dbname', 'DBNAME']) {
    assert.throws(
      () =>
        validateIntegrationDatabaseUrl(
          `postgresql://localhost:5432/lumen_social_test?${parameter}=lumen_social`,
        ),
      /valid PostgreSQL URL/,
    );
  }
});

test('rejects URL fragments without echoing credentials', () => {
  const urlWithFragment =
    'postgresql://localhost:5432/lumen_social_test#fragment';
  assert.throws(
    () => validateIntegrationDatabaseUrl(urlWithFragment),
    (error) => {
      assert.match(error.message, /valid PostgreSQL URL/);
      assert.doesNotMatch(error.message, /secret-value/);
      return true;
    },
  );
});

test('accepts only the dedicated integration-test database name', () => {
  assert.doesNotThrow(() =>
    validateIntegrationDatabaseUrl(
      'postgresql://127.0.0.1:5432/lumen_social_test',
    ),
  );
});

test('integration safety module rejects a missing URL before tests load', () => {
  const result = runIntegrationSafetyModule();

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /DATABASE_URL is required/);
  assert.doesNotMatch(result.stderr, /postgres(?:ql)?:\/\//i);
});

test('integration safety module rejects an unexpected database', () => {
  const result = runIntegrationSafetyModule(
    'postgresql://127.0.0.1:5432/lumen_social_dev',
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /restricted to the "lumen_social_test" database/);
  assert.doesNotMatch(result.stderr, /postgres(?:ql)?:\/\//i);
});

test('integration safety module accepts the dedicated database name without connecting', () => {
  const result = runIntegrationSafetyModule(
    'postgresql://127.0.0.1:5432/lumen_social_test',
  );

  assert.equal(result.status, 0, result.stderr);
});
